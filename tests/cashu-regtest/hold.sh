#!/bin/bash
# A CLN plugin that holds an incoming payment for as long as /tmp/hold exists, then
# fails it if /tmp/hold-fail exists and otherwise lets it complete. The image has no
# Python, and a plugin is only JSON lines on stdin and stdout.
while IFS= read -r line; do
    [ -z "$line" ] && continue
    id=$(jq -c '.id' <<<"$line")
    case "$(jq -r '.method' <<<"$line")" in
    getmanifest)
        printf '{"jsonrpc":"2.0","id":%s,"result":{"options":[],"rpcmethods":[],"hooks":[{"name":"htlc_accepted"}],"subscriptions":[],"dynamic":false}}\n\n' "$id"
        ;;
    htlc_accepted)
        while [ -e /tmp/hold ]; do sleep 0.5; done
        if [ -e /tmp/hold-fail ]; then
            printf '{"jsonrpc":"2.0","id":%s,"result":{"result":"fail","failure_message":"2002"}}\n\n' "$id"
        else
            printf '{"jsonrpc":"2.0","id":%s,"result":{"result":"continue"}}\n\n' "$id"
        fi
        ;;
    *)
        [ "$id" != null ] && printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n\n' "$id"
        ;;
    esac
done
