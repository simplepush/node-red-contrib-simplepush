node-red-contrib-simplepush
======================

[Simplepush](https://simplepush.io) API wrapper for Node-RED.

Supports push notifications and encrypted push notifications to Android and iOS.
----

### Install

Run the following command in your Node-RED user directory - typically `~/.node-red`

    npm install node-red-contrib-simplepush

[![npm](https://img.shields.io/npm/v/node-red-contrib-simplepush.svg)](https://www.npmjs.com/package/node-red-contrib-simplepush)

### Required Inputs
- `msg.payload`(required): The message of the notification

### Optional Inputs (can also be set in the node config)
- `msg.key`: Simplepush key (can be found in the app) that identifies the device the notification is sent to
- `msg.title`: The title of the notification
- `msg.event`: The event of the notification
- `msg.password`: Password (can be set in the app) for encrypted notifications
- `msg.salt`: Salt (can be found in the app) for encrypted notifications


See <a href="https://simplepush.io" target="_new">Simplepush.io</a> for more details.
