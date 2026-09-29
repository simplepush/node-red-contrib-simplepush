node-red-contrib-simplepush
======================

[Simplepush](https://simplepu.sh) nodes for Node-RED.

Send tasks and notifications to Android and iOS, optionally end-to-end encrypted, and get the answers back into your flow: button taps, text, choices, slider values, photos, voice recordings, files and locations. Receive what people send from the app on their own.
----

### Install

Run the following command in your Node-RED user directory - typically `~/.node-red`

    npm install node-red-contrib-simplepush

[![npm](https://img.shields.io/npm/v/node-red-contrib-simplepush.svg)](https://www.npmjs.com/package/node-red-contrib-simplepush)

Requires Node.js 20 or newer and Node-RED 3 or newer.

### Nodes

| Node | What it does |
| --- | --- |
| `simplepush task` | Sends a task and outputs every answer. |
| `simplepush notification` | Sends a push with at most one answer, an image or audio clip, or a link. |
| `simplepush in` | Outputs every submission people send from the app. |
| Simplepush account | Config node with the credentials, shared by all nodes. One connection per account. |

### Account

- **Personal:** API token from the app (Settings > API Token). Optional Personal Password, which encrypts sends to your own devices and decrypts your submissions. Optional topic passwords: a send to a listed topic is encrypted with its password.
- **Organization:** integration token, created by an organization admin with `sp integration create`. Encryption uses the organization's keys, which come with the token.

Topics are created and subscribed to in the app. Leave the topic blank to send to your own devices. An organization send needs exactly one of topic, member or broadcast.

### simplepush task

Inputs are set in the node or passed as `msg.inputs`, in the shape of the [TypeScript SDK](https://simplepu.sh/guide/typescript-sdk):

```js
msg.inputs = [
    { type: "actions", actions: ["Approve", "Deny"] },
    { type: "text", description: "Comment", required: false },
    { type: "choice", options: ["Red", "Green", "Blue"], multi: true, maxSelections: 2 },
    { type: "slider", min: 0, max: 14, step: 0.1, unit: "pH" },
    { type: "photo" }, { type: "voiceRecording" }, { type: "file" }, { type: "location" }
];
```

`required` defaults to `true`. Each type at most once.

Message properties, used when the node's field is blank:

| Property | |
| --- | --- |
| `msg.payload` | The message. Objects are sent as JSON. |
| `msg.topic`, `msg.member`, `msg.broadcast` | The target. `member` and `broadcast` are for organizations. |
| `msg.title`, `msg.tag` | Title and a label to group or filter by. |
| `msg.priority` | 1 (silent) to 5 (critical, sounds on a muted phone). Default 3. |
| `msg.expiresIn` | Seconds until an unanswered task expires. |
| `msg.shared` | `true`: one task for all recipients, the first answer completes it. Default: one task per recipient. |
| `msg.markdown` | `true` renders the message as Markdown. |
| `msg.links` | Array of URLs shown with the task. |
| `msg.attachments` | Array of files: URLs to download, or `{filename, data, contentType}` with `data` a Buffer. |
| `msg.autoCommit` | `true` (default) saves each input as it is filled, `false` shows a Submit button. |

A boolean on the message wins over the node's checkbox.

Outputs: one message per answer. With actions in the node there is one output per action, otherwise the first output. After those, one output each for tasks that ended without an answer: declined, canceled (withdrawn by the sender), expired. A task that everyone deleted from their list ends without a message.

| Property | |
| --- | --- |
| `msg.payload` | The answer: `action`, `text`, `choice`, `choices`, `slider`, `location`, and `photo`, `voice`, `file` as `{data, filename, contentType, size}` with `data` a Buffer. On the outputs for tasks without an answer, the status. |
| `msg.status` | `completed`, `declined`, `canceled` or `expired`. |
| `msg.taskId`, `msg.groupId` | The task, and the group of tasks when every recipient got their own. |
| `msg.recipient` | Who answered: `publicId`, `name`. |
| `msg.completedAt` | When the task was completed. |
| `msg.declines` | On a declined task: who declined, in order, as `{recipient, reason, note}`. One entry per task sent to one recipient; everyone on a shared task. |
| `msg.note` | The note left when declining, when one person declined. |

### simplepush notification

A push that does not stay in the app's task list. One answer at most: action buttons or a choice (up to 3 each), or text. Set in the node or as `msg.input`:

```js
msg.input = { type: "actions", actions: ["Open", "Ignore"] };
```

`msg.image` or `msg.audio` is a URL or `{filename, data, contentType}`. `msg.link` adds an Open link button (any scheme, so an app link opens that app); not together with an answer.

A notification does not expire. Answers leave through the first output (`msg.status` `completed`). With a timeout, recipients who did not answer in time leave through the second output with `msg.status` `pending`. Without one the node waits until everyone answered or the flow is redeployed.

### simplepush in

One message per submission: `msg.payload` has `text`, `location`, and `photo`, `file`, `audio` with `data` a Buffer. `msg.sender`, `msg.submissionId`, `msg.submittedAt`.

### Upgrading from 1.x

Flows from 1.x keep working once the node has an account:

- The old key becomes the topic. The app migration imports every old key as a topic of the same name.
- `event` becomes `tag`, the timeout becomes Expires in, the actions become an actions input with one output per action.
- `salt` is gone. Set a password for the topic in the app and add the topic and password to the account. A password saved on a 1.x node keeps working until then.
- `msg.payload` of an answer is an object: the tapped action is `msg.payload.action`.
- Unanswered tasks leave through their own outputs (declined, canceled, expired) after the action outputs instead of raising an error.
- `msg.key` and `msg.password` raise an error, use `msg.topic` and the account. `msg.salt` is ignored.

See [simplepu.sh](https://simplepu.sh) for more details.
