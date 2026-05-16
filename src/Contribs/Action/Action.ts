// Blocker Buddy context-menu action.
//
// Opens a button-list dialog when the user clicks the menu entry. The dialog
// (Dialog.ts) shows category buttons for an unblocked item, an Unblock button
// for a blocked item, or a setup-instruction message if the team has no
// categories configured yet.
//
// Cascading submenus aren't an option in modern ADO — getMenuItems-style
// registration is from the deprecated vss-web-extension-sdk and isn't honored
// by the current azure-devops-extension-sdk's work-item-context-menu host
// (verified empirically: registering getMenuItems silently falls back to
// firing execute on the manifest's text). The button-list dialog is the
// closest-equivalent UX available.

import * as SDK from "azure-devops-extension-sdk";
import { CommonServiceIds, IHostPageLayoutService } from "azure-devops-extension-api";

console.log("[BlockerBuddy] Action.js loaded");

SDK.init({ loaded: false });

SDK.ready().then(() => {
    SDK.register("blocker-buddy-action-handler", {
        async execute(actionContext: { workItemIds?: number[]; id?: number; workItemId?: number; workItemDirty?: boolean }) {
            // The actionContext shape varies by host:
            //   • Board card kebab / backlog row kebab: { id, workItemIds, ... }
            //   • Work item form kebab: { workItemId, tfsContext, workItemDirty, ... }
            //                            (singular workItemId with capital I)
            // Reading all three keys handles every host the contribution
            // target ms.vss-work-web.work-item-context-menu fires on.
            const id = actionContext?.workItemIds?.[0]
                ?? actionContext?.id
                ?? actionContext?.workItemId;
            if (!id) {
                console.error("[BlockerBuddy] No work item ID in actionContext", actionContext);
                return;
            }

            // Dirty-state flag: actionContext.workItemDirty is only present
            // in form-host invocations (board/backlog actionContexts don't
            // include it). When the form has unsaved edits AND a pending tag
            // edit is among them, saving the form after BB runs would fail
            // with TF26071 "changed by someone else" because BB also writes
            // the tags field. Other dirty fields (description, comments,
            // custom fields) don't conflict, but we can't tell which fields
            // are dirty from here — so we forward the flag to the dialog,
            // which renders an in-modal warning that asks the user to save
            // first. See feedback_ado_action_context_shape_per_host.md.
            const workItemDirty = actionContext?.workItemDirty === true;

            const layoutSvc = await SDK.getService<IHostPageLayoutService>(
                CommonServiceIds.HostPageLayoutService
            );
            const ctx = SDK.getExtensionContext();
            const dialogContributionId = `${ctx.publisherId}.${ctx.extensionId}.blocker-buddy-dialog`;

            // Try to open the dialog. From the board / backlog this works as
            // expected. From the work item form host, openCustomDialog silently
            // does nothing (or layers behind the form modal — we haven't been
            // able to verify which). For now the form-context behavior is a
            // tolerated silent-fail until the diagnostic data above lets us
            // build proper runtime detection.
            try {
                layoutSvc.openCustomDialog(dialogContributionId, {
                    title: "Blocker Buddy",
                    configuration: { workItemId: id, workItemDirty },
                    onClose: (result: unknown) => {
                        console.log("[BlockerBuddy] dialog closed with result:", result);
                    }
                });
            } catch (err) {
                console.error("[BlockerBuddy] openCustomDialog failed:", err);
            }
        }
    });
    SDK.notifyLoadSucceeded();
}).catch((err: unknown) => {
    console.error("[BlockerBuddy] SDK.ready() rejected:", err);
});
