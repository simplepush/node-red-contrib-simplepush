module.exports = function(RED) {
    var shared = require('./lib/shared');

    // A setting missing from the account; trying again won't help.
    function configError(message) {
        var err = new Error(message);
        err.name = 'SimplepushConfigError';
        return err;
    }

    // One Simplepush account shared by every node that selects it: one client,
    // one event connection. A personal account signs in with an API token and
    // holds the topic passwords and the Personal Password; an organization
    // signs in with an integration token, which brings the organization's
    // encryption keys.
    function SimplepushAccountNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var credentials = node.credentials || {};
        node.organization = config.account === 'organization';

        var topics = [];
        if (credentials.topics) {
            try {
                topics = JSON.parse(credentials.topics).filter(function(t) { return t && t.topic && t.password; });
            } catch (err) {
                node.error('Simplepush: the topic passwords could not be read, enter them again');
            }
        }
        node.personalPassword = node.organization ? undefined : credentials.personalPassword || undefined;

        var clientPromise;
        node.client = function() {
            if (!clientPromise) {
                clientPromise = shared.loadSdk().then(function(sdk) {
                    if (node.organization) {
                        if (!credentials.integrationToken) {
                            throw configError('Simplepush error: enter an integration token in the Simplepush account (sp integration create)');
                        }
                        return sdk.OrgClient.fromIntegrationToken(credentials.integrationToken);
                    }
                    if (!credentials.apiToken) {
                        throw configError('Simplepush error: enter an API token in the Simplepush account (app: Settings > API Token)');
                    }
                    var passwords = topics.map(function(t) { return [t.password, t.topic]; });
                    if (node.personalPassword) { passwords.push(node.personalPassword); }
                    return new sdk.Client({ apiToken: credentials.apiToken, passwords: passwords });
                });
                // A failed start (a wrong token, the server unreachable) is
                // tried again on the next use.
                clientPromise.catch(function() { clientPromise = undefined; });
            }
            return clientPromise;
        };

        // The send target and password of a task or notification. Exactly one
        // of topic, member or broadcast for an organization; a topic or your
        // own devices for a personal account.
        node.target = function(topic, member, broadcast, legacyPassword) {
            if (!node.organization && (member || broadcast)) {
                throw new Error('Simplepush error: member and broadcast need an organization account');
            }
            if (node.organization) {
                if ([topic, member, broadcast].filter(Boolean).length !== 1) {
                    throw new Error('Simplepush error: an organization send needs exactly one of topic, member or broadcast');
                }
                var target = {};
                if (topic) { target.topic = String(topic); }
                if (member) { target.member = String(member); }
                if (broadcast) { target.broadcast = true; }
                return target;
            }
            if (!topic) {
                return node.personalPassword ? { password: node.personalPassword } : {};
            }
            // Topic passwords come from the account; flows saved by version
            // 1.x can still carry one on the node.
            var known = topics.some(function(t) { return t.topic === String(topic); });
            return legacyPassword && !known ? { topic: String(topic), password: legacyPassword } : { topic: String(topic) };
        };

        node.on('close', function(done) {
            var pending = clientPromise;
            clientPromise = undefined;
            if (!pending) { return done(); }
            pending.then(function(client) { client.close(); }, function() {}).then(function() { done(); });
        });
    }

    RED.nodes.registerType('simplepush-account', SimplepushAccountNode, {
        credentials: {
            apiToken: { type: 'password' },
            integrationToken: { type: 'password' },
            personalPassword: { type: 'password' },
            // JSON list of { topic, password }. A text credential, so the
            // editor can show the list it edits; it is stored encrypted like
            // every credential.
            topics: { type: 'text' }
        }
    });
};
