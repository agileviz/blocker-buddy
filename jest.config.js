module.exports = {
    "roots": [
        "<rootDir>/src"
    ],
    "testMatch": [
        "**/__tests__/**/*.+(ts|tsx|js)",
        "**/?(*.)+(spec|test).+(ts|tsx|js)"
    ],
    "transform": {
        "^.+\\.(ts|tsx)$": "ts-jest"
    },
    // The published azure-devops-extension-sdk and azure-devops-extension-api
    // modules are AMD-only — they call `define(...)` at top level, which throws
    // ReferenceError under Jest's Node runtime. Pure helpers in src/Library/
    // never invoke the SDK at module load time, so an empty stub keeps the
    // import chain quiet without forcing each test file to mock individually.
    "moduleNameMapper": {
        "^azure-devops-extension-sdk$":      "<rootDir>/src/Library/__mocks__/ado-sdk-stub.ts",
        "^azure-devops-extension-api$":      "<rootDir>/src/Library/__mocks__/ado-sdk-stub.ts",
        "^azure-devops-extension-api/(.*)$": "<rootDir>/src/Library/__mocks__/ado-sdk-stub.ts"
    },
    "coveragePathIgnorePatterns": [
        "/node_modules/",
        "/__mocks__/"
    ]
};
