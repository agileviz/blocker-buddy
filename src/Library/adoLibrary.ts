import * as SDK from "azure-devops-extension-sdk";

import { WorkItemTrackingRestClient, WorkItemBatchGetRequest,
        WorkItem, WorkItemStateColor } from "azure-devops-extension-api/WorkItemTracking";

import { getClient, IProjectPageService, IProjectInfo, CommonServiceIds } from 'azure-devops-extension-api/Common';
import { CoreRestClient, WebApiTeam, TeamContext } from "azure-devops-extension-api/Core";
import { WorkRestClient, BacklogLevelConfiguration, TeamSettingsIteration } from "azure-devops-extension-api/Work";

// Module-level lazy state holders for the ADO SDK clients. Definite-assignment
// asserted (`!`) — `ensureProject()` is contracted to run before any read site,
// and the call sites in this file all do so. Avoids the `T | undefined` noise
// of redundant null-checks at every read while keeping the types informative.
let projectInfoService!: IProjectPageService;
let project!: IProjectInfo;
let workItemTrackingRestClient!: WorkItemTrackingRestClient;

async function ensureProject(): Promise<void> {
    if (project && workItemTrackingRestClient) return;
    projectInfoService = await SDK.getService<IProjectPageService>(CommonServiceIds.ProjectPageService);
    const p = await projectInfoService.getProject();
    if (typeof p === "undefined") {
        throw new Error("Project is undefined");
    }
    project = p;
    workItemTrackingRestClient = getClient(WorkItemTrackingRestClient);
}

const WORK_ITEM_BATCH_LIMIT = 200;

// Fetch work items in batches of 200 (ADO API limit per request), in parallel.
export async function getWorkItems (workItemRequest: WorkItemBatchGetRequest) : Promise<Array<WorkItem>> {
    // Self-seed rather than relying on a prior ensureProject() call from
    // queryWorkItemIds() — getWorkItems() should work standalone so future
    // callers don't have to know the implicit ordering contract.
    await ensureProject();
    const ids = workItemRequest.ids;

    // ADO's workItemsBatch endpoint rejects empty id arrays with 400 Bad Request.
    // Short-circuit so a query that returns no results doesn't crash the widget.
    if (ids.length === 0) return [];

    if (ids.length <= WORK_ITEM_BATCH_LIMIT) {
        return workItemTrackingRestClient.getWorkItemsBatch(workItemRequest);
    }

    const chunks: Array<Promise<Array<WorkItem>>> = [];
    for (let i = 0; i < ids.length; i += WORK_ITEM_BATCH_LIMIT) {
        chunks.push(workItemTrackingRestClient.getWorkItemsBatch({
            ...workItemRequest,
            ids: ids.slice(i, i + WORK_ITEM_BATCH_LIMIT)
        }));
    }
    const results = await Promise.all(chunks);
    return ([] as Array<WorkItem>).concat(...results);
}

// get definition of a single work item type's states (small payload, includes each state's name, category, and color)
export async function getWorkItemTypeStates (wit : string) : Promise<Array<WorkItemStateColor>> {

    const projectService = await SDK.getService<IProjectPageService>(CommonServiceIds.ProjectPageService);
    let project = await projectService.getProject();
    if (typeof project === "undefined") project = {name: "", id: ""};
    const workItemTrackingRestClient = getClient(WorkItemTrackingRestClient);

    return workItemTrackingRestClient.getWorkItemTypeStates(project.id, wit);
}

// Get all teams for the current project. Used by the Throughput config pane
// to populate the Team dropdown.
export async function getTeams(): Promise<Array<WebApiTeam>> {
    await ensureProject();
    const coreClient = getClient(CoreRestClient);
    return coreClient.getTeams(project.id);
}

// URL prefix for individual work items, suitable for appending an item ID:
// "https://dev.azure.com/{org}/{project}/_workitems/edit/". Used by the
// "Copy items as TSV" export so each row carries a clickable link back to
// ADO. Cloud-only — Azure DevOps Server (on-prem) follows a different URL
// pattern that's not derivable from getHost() alone. Acceptable: 99%+ of
// AgileViz install volume is dev.azure.com cloud, and the export is still
// usable without working URLs (other 14 columns are unaffected).
export async function getWorkItemUrlPrefix(): Promise<string> {
    await ensureProject();
    const host = SDK.getHost();
    return `https://dev.azure.com/${host.name}/${encodeURIComponent(project.name)}/_workitems/edit/`;
}

// Role of a backlog level within the project's hierarchy. Derived from WHICH
// field of BacklogConfiguration the entry came from — there's no `role` or
// `type` field on BacklogLevelConfiguration itself, so we tag each entry as
// we flatten the three-field response into a single array.
export type BacklogRole = 'portfolio' | 'requirement' | 'task';

export interface BacklogWithRole extends BacklogLevelConfiguration {
    role: BacklogRole;
}

// Get the backlogs VISIBLE to a specific team, each tagged with its role
// ('portfolio' / 'requirement' / 'task'). Respects team-level backlog
// configuration — a team with Epics + Features + Backlog-items enabled returns
// three entries; a team with only Backlog-items enabled returns one. Supports
// the multi-backlog Kanban "replenishment" pattern.
//
// Important: getBacklogs() returns ALL project backlogs regardless of team-level
// visibility — a hidden backlog would leak through. getBacklogConfigurations()
// returns the same backlogs plus a team-scoped `hiddenBacklogs` list that
// identifies which are hidden for this team. Filter by that list for correct
// team-visible behavior.
export async function getBacklogsForTeam(teamId: string): Promise<Array<BacklogWithRole>> {
    await ensureProject();
    const workClient = getClient(WorkRestClient);
    const teamContext: TeamContext = {
        projectId: project.id,
        project:   project.name,
        teamId:    teamId,
        team:      ""
    };
    const config = await workClient.getBacklogConfigurations(teamContext);
    const hiddenIds = new Set<string>(config.hiddenBacklogs || []);
    const all: BacklogWithRole[] = [];
    if (config.portfolioBacklogs) {
        for (const b of config.portfolioBacklogs) all.push({ ...b, role: 'portfolio' });
    }
    if (config.requirementBacklog) {
        all.push({ ...config.requirementBacklog, role: 'requirement' });
    }
    if (config.taskBacklog) {
        all.push({ ...config.taskBacklog, role: 'task' });
    }
    return all.filter(b => !hiddenIds.has(b.id));
}

// Get the team's iteration list. Used for Sprint-interval bucketing — each
// iteration's startDate/finishDate defines a window. Iterations without dates
// set are filtered out by intervalWindows.computeIntervalWindows().
export async function getTeamIterations(teamId: string): Promise<Array<TeamSettingsIteration>> {
    await ensureProject();
    const workClient = getClient(WorkRestClient);
    const teamContext: TeamContext = {
        projectId: project.id,
        project:   project.name,
        teamId:    teamId,
        team:      ""
    };
    return workClient.getTeamIterations(teamContext);
}

// Team area path reference — returned by getTeamFieldValues and consumed by
// the WIQL builder. `includeChildren` true → `UNDER` clause; false → `=`.
export interface TeamAreaPathRef {
    path: string;
    includeChildren: boolean;
}

// Get the team's configured area paths. ADO teams don't own work items
// directly; they own area-path ranges, and work items own area paths. UNION
// of these is the correct WIQL filter for "this team's work."
export async function getTeamAreaPaths(teamId: string): Promise<Array<TeamAreaPathRef>> {
    await ensureProject();
    const workClient = getClient(WorkRestClient);
    const teamContext: TeamContext = {
        projectId: project.id,
        project:   project.name,
        teamId:    teamId,
        team:      ""
    };
    const fieldValues = await workClient.getTeamFieldValues(teamContext);
    return (fieldValues.values || []).map(v => ({
        path: v.value,
        includeChildren: !!v.includeChildren
    }));
}

// Gather state names categorized as "Completed" across a set of work-item
// types. WIQL has no StateCategory predicate, so we enumerate the actual
// state names each type considers completed (e.g., "Done" in Scrum,
// "Closed" in Agile, "Resolved" in some custom processes) and use them
// in a `[System.State] IN (...)` clause. Returns deduplicated list across
// all provided types.
export async function getCompletedStateNamesForTypes(typeNames: Array<string>): Promise<Array<string>> {
    const all = new Set<string>();
    // Serial to keep error locality obvious; N is small (types per backlog).
    for (const typeName of typeNames) {
        try {
            const states = await getWorkItemTypeStates(typeName);
            for (const state of states) {
                if (state.category === "Completed" && state.name) {
                    all.add(state.name);
                }
            }
        } catch (err) {
            // A single type's state fetch failing shouldn't abort all types.
            console.warn(`getCompletedStateNamesForTypes: state lookup failed for type "${typeName}"`, err);
        }
    }
    return Array.from(all);
}

// Execute a WIQL query string, return the list of work item IDs. The result
// itself carries no fields — callers must batch-fetch fields separately with
// getWorkItems() using these IDs.
//
// timePrecision=true tells ADO our WIQL date filters carry real time
// components (full ISO timestamps with HH:MM:SS), not just calendar dates.
// Required because Month/Quarter windows align to the user's local midnight,
// which becomes a non-midnight UTC time after timezone conversion (e.g.,
// "2026-04-01T05:00:00.000Z" for Chicago). Without this flag, ADO defaults
// to date precision and rejects non-midnight times with:
//   "You cannot supply a time with the date when running a query using date precision."
// Sprint queries happen to pass without the flag because ADO iterations are
// stored as UTC midnight, but our pipeline can produce non-midnight UTC
// instants for Month/Quarter, so we set the flag uniformly.
export async function queryWorkItemIds(wiql: string): Promise<Array<number>> {
    await ensureProject();
    if (!workItemTrackingRestClient) workItemTrackingRestClient = getClient(WorkItemTrackingRestClient);
    const result = await workItemTrackingRestClient.queryByWiql(
        { query: wiql }, project.id, undefined, true
    );
    return (result.workItems || []).map(wi => wi.id);
}
