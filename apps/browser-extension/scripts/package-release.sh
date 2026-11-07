#!/usr/bin/env bash
# Builds the Chrome and Firefox extensions and zips each into build/, named for
# the version: the zips a GitHub release carries. Takes the release tag (v1.2.3) or,
# with none, the version in package.json. Run from anywhere, after the shared
# packages are built and the extension's dependencies are installed.
set -euo pipefail

cd "$(dirname "$0")/.."

die() { echo "package-release: $*" >&2; exit 1; }
version_of() { node -p "require('./$1').version"; }

package_version=$(version_of package.json)
tag=${1:-v$package_version}
[[ "$tag" =~ ^v[0-9] ]] || die "'$tag' is not a release tag such as v1.2.3"
version=${tag#v}

for file in package.json src/static/manifest.json src/static/manifest.firefox.json; do
    found=$(version_of "$file")
    [[ "$found" == "$version" ]] || die "$file is at $found, not $version"
done

rm -rf build
mkdir build

package() {
    local browser=$1
    npm run "build:$browser"
    [[ "$(version_of dist/manifest.json)" == "$version" ]] || die "dist/manifest.json is not at $version"
    # At the root of the zip, where browsers look for the manifest. The build copies
    # both source manifests, and manifest.json is the one for this browser.
    (cd dist && zip -qr "../build/archon-wallet-$browser-$tag.zip" . -x manifest.firefox.json)
}

package chrome
node -e "if (require('./dist/manifest.json').browser_specific_settings) process.exit(1)" \
    || die "the Chrome build has the Firefox manifest"
package firefox
node -e "if (!require('./dist/manifest.json').browser_specific_settings?.gecko) process.exit(1)" \
    || die "the Firefox build has no gecko settings"

ls -l build
