/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

const path = require("path");
const { merge } = require("webpack-merge");
const webpack = require("webpack");
// const { CleanWebpackPlugin } = require("clean-webpack-plugin");

module.exports = env => {
    const isProduction = env && env.production;

    return merge({
        entry: {
            sharedWorkerServer: "./src/sharedWorkerServer.ts"
        },
        resolve: {
            extensions: [".ts", ".tsx", ".js"],
        },
        module: {
            rules: [{
                test: /\.tsx?$/,
                loader: require.resolve("ts-loader")
            }]
        },
        output: {
            filename: "[name].bundle.js",
            path: path.resolve(__dirname, "dist"),
            library: "[name]",
            // https://github.com/webpack/webpack/issues/5767
            // https://github.com/webpack/webpack/issues/7939
            devtoolNamespace: "fluidframework/hack-local-driver",
            libraryTarget: "umd"
        },
        plugins: [
            new webpack.ProvidePlugin({
                process: 'process/browser'
            }),
        ],
    }, isProduction
        ? require("./webpack.prod")
        : require("./webpack.dev"));
};
