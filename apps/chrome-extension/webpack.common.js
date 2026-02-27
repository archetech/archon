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
        offscreen: path.resolve("./src/offscreen/offscreen.ts"),
    },
    module: {
        rules: [
            {
                use: "ts-loader",
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
        ...getHtmlPlugins(["browser", "popup", "offscreen"]),
    ],
    resolve: {
        extensions: [".ts", ".tsx", ".js"],
        alias: {
            "@didcid/cipher/web": path.resolve(__dirname, "../../packages/cipher/dist/esm/cipher-web.js"),
            "@didcid/common/errors": path.resolve(__dirname, "../../packages/common/dist/esm/errors.js"),
            "@didcid/gatekeeper/client": path.resolve(__dirname, "../../packages/gatekeeper/dist/esm/gatekeeper-client.js"),
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
        title: "Archon Chrome Extension",
        filename: `${chunk}.html`,
        chunks: [chunk],
    }))
}
