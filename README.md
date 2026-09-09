node-red-contrib-simplepush
======================

[Simplepush](https://simplepu.sh) node for Node-RED.

Sends tasks and encrypted tasks to Android and iOS, with action buttons whose answer flows back into Node-RED.
----

### Install

Run the following command in your Node-RED user directory - typically `~/.node-red`

    npm install node-red-contrib-simplepush

[![npm](https://img.shields.io/npm/v/node-red-contrib-simplepush.svg)](https://www.npmjs.com/package/node-red-contrib-simplepush)

Requires Node.js 20 or newer and Node-RED 3 or newer.

### Setup
- Create an API token in the Simplepush app under Settings > API Token and enter it in the node config.
- Tasks are sent to a topic. Topics are created and subscribed to in the app. Leave the topic blank to send to your own devices.
- For encrypted tasks to a topic set a password for the topic in the app and enter it as Topic Password in the node config. For encrypted tasks to your own devices enter your Personal Password from the app.

### Required Inputs
- `msg.payload`(required): The message of the task

### Optional Inputs (can also be set in the node config)
- `msg.topic`: The topic the task is sent to
- `msg.title`: The title of the task
- `msg.attachments`: Array of URLs to images, videos or other files that are downloaded and attached to the task (at most 10)
- `msg.tag`: A label the app can group or filter tasks by
- `msg.actions`: Array of strings that will be shown as action buttons on the task. Tapping one completes the task.
- `msg.timeout`: Time in seconds after which a timeout error will be thrown and the task expires on the device. 0 (the default) means no timeout. Only used when the timeout field in the node config is blank.
- `msg.autoCommit`: `true` (default) completes the task as soon as an action is tapped, `false` shows a Submit button. Overrides the Auto commit checkbox.
- `msg.password`: The topic's password (set in the app) for encrypted tasks to a topic
- `msg.personalPassword`: Your Personal Password (set in the app) for encrypted tasks to your own devices
- `msg.apiToken`: Overrides the API token from the node config

Values set in the node config take precedence over message properties, except `msg.autoCommit`.

### Outputs
When actions are configured in the node there is one output per action and the message leaves through the output of the tapped action. When the actions come from `msg.actions` there is a single output.

- `msg.payload`: The tapped action
- `msg.taskId`: Id of the task that was answered
- `msg.actionSelectedAt`: When the action was tapped
- `msg.recipient`: Who answered (`publicId`, `name`)

### Upgrading from 1.x
Version 2 uses the current Simplepush app and API and sends tasks instead of notifications. Flows from 1.x keep working after you enter an API token in the node config:

- The old key becomes the topic. The app migration imports every old key as a topic of the same name.
- `event` becomes `tag`.
- `salt` is gone. Set a password for the topic in the app and enter it as Topic Password in the node config.
- `msg.key` is no longer supported. Use `msg.topic`.

See <a href="https://simplepu.sh" target="_new">simplepu.sh</a> for more details.
