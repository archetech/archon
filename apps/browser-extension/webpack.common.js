const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlPlugin = require('html-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');

module.exports = {
    entry: {
        popup: path.resolve("./src/popup.tsx"),
        browser: path.resolve("./src/browser.tsx"),
        background: path.resolve("./src/background/background.ts"),
        contentScript: path.resolve("./src/contentScript/contentScript.ts"),
        "nostr-provider": path.resolve("./src/contentScript/nostr-provider.ts"),
    },
    module: {
        rules: [
            {
                // transpileOnly: type checking happens in `npm run typecheck`,
                // not here. Since the shared wallet-ui components brought MUI's
                // real generics into scope, checking inside the bundle recursed
                // deep enough to blow the stack -- and did it for the Firefox
                // build while Chrome squeaked through, which is the signature of
                // a threshold rather than a type error. Transpiling is also
                // several times faster, and tsc remains the authority.
                use: { loader: "ts-loader", options: { transpileOnly: true } },
                test: /\.tsx?$/,
                exclude: /node_modules/,
            },
            {
                use: ["style-loader", "css-loader"],
                test: /\.css$/i,
            },
            {
                type: "asset/resource",
                test: /\.(png|jpe?g|gif|svg|woff|woff2|eot|ttf)$/,
            }
        ]
    },
    plugins: [
        new webpack.ProvidePlugin({
            Buffer: ['buffer', 'Buffer'],
        }),
        new webpack.DefinePlugin({
            'process.env.ARCHON_DEFAULT_REGISTRY': JSON.stringify(
                process.env.ARCHON_DEFAULT_REGISTRY || 'hyperswarm'
            ),
        }),
        new CleanWebpackPlugin({
            cleanStaleWEbpackAssets: false,
        }),
        new CopyPlugin({
            patterns: [
                {
                    from: path.resolve('src/static'),
                    to: path.resolve('dist'),
                }
            ]
        }),
        ...getHtmlPlugins(["browser", "popup"]),
    ],
    resolve: {
        extensions: [".ts", ".tsx", ".js"],
        alias: {
            "@didcid/wallet-ui": path.resolve(__dirname, "../../packages/wallet-ui/src/index.ts"),
            // wallet-ui-dedupe: the shared package sits outside this app, so its
            // React/MUI imports must resolve to this app's copies rather than a
            // second set from the repo root.
            "@mui/material": path.resolve(__dirname, "node_modules/@mui/material"),
            "@mui/icons-material": path.resolve(__dirname, "node_modules/@mui/icons-material"),
            "@emotion/react": path.resolve(__dirname, "node_modules/@emotion/react"),
            "@emotion/styled": path.resolve(__dirname, "node_modules/@emotion/styled"),
            "react": path.resolve(__dirname, "node_modules/react"),
            "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
            "@didcid/cipher/web": path.resolve(__dirname, "../../packages/cipher/dist/esm/cipher-web.js"),
            "@didcid/common/errors": path.resolve(__dirname, "../../packages/common/dist/esm/errors.js"),
            "@didcid/clients/gatekeeper": path.resolve(__dirname, "../../packages/clients/dist/esm/gatekeeper-client.js"),
            "@didcid/gatekeeper/types": path.resolve(__dirname, "../../packages/gatekeeper/dist/types/types.d.js"),
            "@didcid/keymaster/wallet/chrome": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/chrome.js"),
            "@didcid/keymaster/wallet/json-memory": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/json-memory.js"),
            "@didcid/keymaster/wallet/cache": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/cache.js"),
            "@didcid/keymaster/wallet/typeGuards": path.resolve(__dirname, "../../packages/keymaster/dist/esm/db/typeGuards.js"),
            "@didcid/keymaster/types": path.resolve(__dirname, "../../packages/keymaster/dist/types/types.d.js"),
            "@didcid/keymaster/search": path.resolve(__dirname, "../../packages/keymaster/dist/esm/search-client.js"),
            "@didcid/cipher/passphrase": path.resolve(__dirname, "../../packages/cipher/dist/esm/passphrase.js"),
            "@didcid/keymaster": path.resolve(__dirname, "../../packages/keymaster/dist/esm/keymaster.js"),
        },
        fallback: {
            buffer: require.resolve("buffer")
        },
    },
    output: {
        filename: "[name].js",
        path: path.resolve("dist"),
    },
    optimization: {
        splitChunks: false
    }
}

function getHtmlPlugins(chunks) {
    return chunks.map(chunk => new HtmlPlugin({
        title: "Archon Wallet",
        filename: `${chunk}.html`,
        chunks: [chunk],
    }))
}
