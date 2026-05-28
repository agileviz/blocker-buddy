const path = require("path");
const fs = require("fs");
const CopyWebpackPlugin = require("copy-webpack-plugin");

const entries = {};
const contribsDir = path.join(__dirname, "src/Contribs");
fs.readdirSync(contribsDir).filter(dir => {
    if (fs.statSync(path.join(contribsDir, dir)).isDirectory()) {
        entries[dir] = "./" + path.relative(process.cwd(), path.join(contribsDir, dir, dir));
    }
});

module.exports = (env, argv) => {
    const isDev = argv?.mode === "development";

    const config = {
        entry: entries,
        output: {
            filename: "[name]/[name].js",
            // Dev server serves bundles at /dist/ to match the extension manifest URIs
            // (e.g. baseUri=https://localhost:3000 + uri=dist/Widget/Widget.html)
            publicPath: isDev ? "/dist/" : "auto"
        },
        resolve: {
            extensions: [".ts", ".tsx", ".js"],
            alias: {
                "azure-devops-extension-sdk": path.resolve("node_modules/azure-devops-extension-sdk"),
                // Force the ES-module build of slim-select. The UMD build falls through to
                // the globalThis branch under webpack and never populates module.exports.
                "slim-select$": path.resolve("node_modules/slim-select/dist/slimselect.es.js"),
            },
        },
        stats: {
            warnings: false
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    loader: "ts-loader"
                },
                {
                    test: /\.scss$/,
                    use: ["style-loader", { loader: "css-loader", options: { sourceMap: true } }, { loader: "sass-loader", options: { sourceMap: true, sassOptions: { quietDeps: true, silenceDeprecations: ["legacy-js-api", "import"] } } }]
                },
                {
                    test: /\.css$/,
                    use: ["style-loader", "css-loader"],
                }
            ]
        },
        plugins: [
            new CopyWebpackPlugin({
                patterns: [
                    { from: "**/*.html", context: "src/Contribs" }
                ]
            })
        ]
    };

    if (isDev) {
        config.devServer = {
            port: 3000,
            server: "https",
            static: [
                { directory: path.join(__dirname, "static"), publicPath: "/static" }
            ],
            // Required for devcontainer port forwarding and ADO iframe origin
            allowedHosts: "all",
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Methods": "*",
                // Chrome's Private Network Access policy blocks public origins
                // (dev.azure.com) from loading subresources from loopback addresses
                // (localhost) without explicit consent. Without this header the
                // iframe loads fail silently — no parent-page error, no handler
                // registers, click does nothing. See feedback_ado_dev_server_pna.md
                // in project memory.
                "Access-Control-Allow-Private-Network": "true"
            },
            // webpack-dev-server's `headers` config doesn't always reach the
            // `static` middleware paths (known quirk). Apply the PNA header
            // explicitly via setupMiddlewares so every response carries it,
            // including static assets like static/icon.png and the iframe HTML
            // that ADO loads on click. Also explicitly answer OPTIONS preflight
            // requests — Chrome PNA increasingly sends preflights for cross-
            // origin private-network subresources, and webpack-dev-server's
            // default 404 for OPTIONS on static paths fails the preflight.
            setupMiddlewares: (middlewares, devServer) => {
                devServer.app.use((req, res, next) => {
                    res.setHeader("Access-Control-Allow-Private-Network", "true");
                    res.setHeader("Access-Control-Allow-Origin", "*");
                    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                    res.setHeader("Access-Control-Allow-Headers", "*");
                    if (req.method === "OPTIONS") {
                        res.status(204).end();
                        return;
                    }
                    next();
                });
                return middlewares;
            },
            // No HMR — ADO iframes can't receive WS messages for hot reload.
            // Refresh the ADO dashboard page manually after webpack recompiles.
            hot: false,
            liveReload: false,
            client: {
                // Show errors in the overlay but not warnings (many come from third-party SCSS)
                overlay: { errors: true, warnings: false }
            }
        };
    }

    return config;
};
