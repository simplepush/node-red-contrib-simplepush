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

// Comma separated labels, which may contain spaces.
function splitLabels(value) {
    return String(value).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

// A config field wins when it holds something; a blank field defers to msg.
function pick(configValue, msgValue) {
    if (configValue !== undefined && configValue !== null && String(configValue).trim() !== '') {
        return configValue;
    }
    return msgValue;
}

// A checkbox is never blank, so a boolean on msg wins over it.
function pickBoolean(configValue, msgValue) {
    return typeof msgValue === 'boolean' ? msgValue : Boolean(configValue);
}

function parseSeconds(value, name) {
    if (value === undefined || value === null || String(value).trim() === '') { return undefined; }
    var seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error('Simplepush error: ' + name + ' must be a number of seconds');
    }
    return seconds > 0 ? seconds : undefined;
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

// Who a message went to: the group instance's recipient, or for a shared
// task whoever answered.
function recipientOf(groupRecipient, actor) {
    if (groupRecipient) { return { publicId: groupRecipient.publicId, name: groupRecipient.name }; }
    if (actor) { return { publicId: actor.publicId, name: actor.name === undefined ? null : actor.name }; }
    return undefined;
}

// Downloads a photo, voice recording or file and returns it with its data as
// a Buffer. A failed download keeps the details without data.
async function readFile(node, upload, what) {
    var file = { id: upload.id, filename: upload.filename, contentType: upload.contentType, size: upload.size };
    if (upload.durationSeconds !== undefined) { file.durationSeconds = upload.durationSeconds; }
    try {
        file.data = Buffer.from(await upload.read());
    } catch (err) {
        node.warn('Simplepush: could not download the ' + what + ' ' + upload.id + ': ' + (err && err.message || err));
    }
    return file;
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
    splitLabels: splitLabels,
    pick: pick,
    pickBoolean: pickBoolean,
    parseSeconds: parseSeconds,
    fetchFile: fetchFile,
    recipientOf: recipientOf,
    readFile: readFile,
    asGroup: asGroup
};
