// Helpers shared by the Simplepush nodes.

// @simplepush/sdk is ESM-only; the node files are CommonJS, so it is loaded
// through a dynamic import the first time it is needed.
let sdkPromise;
function loadSdk() {
    if (!sdkPromise) { sdkPromise = import('@simplepush/sdk'); }
    return sdkPromise;
}

function splitList(value) {
    return String(value).split(/[ ,]+/).filter(Boolean);
}

// Downloads a URL so it can be uploaded as a task file attachment.
async function fetchFile(url) {
    var res = await fetch(url);
    if (!res.ok) {
        throw new Error('Simplepush error: could not fetch ' + url + ' (status ' + res.status + ')');
    }
    var filename = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '') || 'attachment';
    var contentType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    return { filename: filename, data: new Uint8Array(await res.arrayBuffer()), contentType: contentType };
}

// Treats a self-send's single Task like a group, whose
// inputs() yields { instance, item, recipient }.
function asGroup(sent) {
    if (sent.instances) { return sent; }
    return {
        instances: [sent],
        inputs: async function*(streamOptions) {
            for await (const item of sent.inputs(streamOptions)) {
                yield { instance: sent, item: item };
            }
        }
    };
}

module.exports = {
    loadSdk: loadSdk,
    splitList: splitList,
    fetchFile: fetchFile,
    asGroup: asGroup
};
