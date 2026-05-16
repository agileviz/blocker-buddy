// Empty stub for azure-devops-* modules under Jest. Their published bundles
// are AMD-only (top-level `define(...)`), so loading them in Node throws
// `ReferenceError: define is not defined` before any test runs. Pure helpers
// in src/Library/ never call the SDK at module load — only inside functions
// that aren't exercised by these unit tests — so a default-empty object is
// enough to keep imports working. Wired up via moduleNameMapper in
// jest.config.js for every azure-devops-extension-* path.
export {};
export default {};
