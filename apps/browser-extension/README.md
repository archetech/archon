## Installing from a Release

Each [GitHub release](https://github.com/archetech/archon/releases) has a zip for each
browser: `archon-wallet-chrome-v<version>.zip` and `archon-wallet-firefox-v<version>.zip`.

**Chrome**, and other Chromium browsers:

1. Unzip the file into a folder you will keep, because the browser loads it from there
2. Navigate to `chrome://extensions/`
3. Enable `Developer mode`
4. Open `Load unpacked` and select the folder

**Firefox:** the zip isn't signed, and release versions of Firefox only install signed
add-ons permanently, so it lasts until Firefox restarts:

1. Navigate to `about:debugging#/runtime/this-firefox`
2. Open `Load Temporary Add-on` and select the zip

## Getting Started

1. `npm i` to install dependencies
2. `npm start` to to build and bundle files 
into the `dist` folder.

## Loading the Extension

1. Navigate to `chrome://extensions/`
2. Enable `Developer mode`
3. Open `Load unpacked`
4. Select the `dist` folder

## Production Build

1. `npm run build` to generate a production build to the `dist` folder
2. Zip the `dist` folder
3. Publish the Zip on the Chrome Web Store

`scripts/package-release.sh` builds both browsers and writes the zips a release carries
to `build/`. It refuses a version that differs from `package.json` or either manifest.
