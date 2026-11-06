'use strict';

const NODE_LIST_PATH = '/api/nodes/list';
const NODE_UNPAIR_PATH = '/api/nodes/unpair';
const NODE_DISCONNECT_PATH = '/api/nodes/disconnect';
const NODE_HEARTBEAT_PATH = '/api/nodes/heartbeat';
const PROXY_DISPLAY_NAME = 'Muse Local Proxy';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function nodeTimestamp(node) {
  for (const key of ['last_seen_at', 'paired_at']) {
    const value = node?.[key];
    if (typeof value !== 'string') continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isOnline(node) {
  return node?.online === true || node?.connection_state === 'online';
}

/**
 * Returns nodes sorted from the most useful (online, recently paired) to the
 * least useful. The server may return `nodes` or `devices` depending on the
 * endpoint version.
 */
function sortNodes(nodes) {
  return [...nodes].sort((a, b) => {
    const online = Number(isOnline(b)) - Number(isOnline(a));
    if (online !== 0) return online;
    return nodeTimestamp(b) - nodeTimestamp(a);
  });
}

async function listNodes(gateway, { timeoutMs = 20000 } = {}) {
  const res = await gateway.request('POST', NODE_LIST_PATH, {}, { timeoutMs });
  const data = res.json || {};
  const nodes = data.nodes ?? data.devices;
  return Array.isArray(nodes) ? sortNodes(nodes) : [];
}

async function unpairNode(gateway, nodeId, { timeoutMs = 20000 } = {}) {
  return gateway.request('POST', NODE_UNPAIR_PATH, { node_id: nodeId }, { timeoutMs });
}

async function disconnectNode(gateway, nodeId, { timeoutMs = 20000 } = {}) {
  return gateway.request('POST', NODE_DISCONNECT_PATH, { node_id: nodeId }, { timeoutMs });
}

async function heartbeatNode(gateway, nodeId, { timeoutMs = 20000 } = {}) {
  return gateway.request('POST', NODE_HEARTBEAT_PATH, { node_id: nodeId }, { timeoutMs });
}

/**
 * Picks the node that should own the proxy's commands. Only nodes registered
 * with the proxy's display name and a UUID-shaped id are considered, so the
 * old malformed registration cannot win again.
 */
function pickProxyNode(nodes, { displayName = PROXY_DISPLAY_NAME } = {}) {
  const candidates = sortNodes(
    (nodes || []).filter(
      (node) => node?.display_name === displayName && isUuid(node?.node_id)
    )
  );
  return candidates[0] || null;
}

module.exports = {
  NODE_LIST_PATH,
  NODE_UNPAIR_PATH,
  NODE_DISCONNECT_PATH,
  NODE_HEARTBEAT_PATH,
  PROXY_DISPLAY_NAME,
  isUuid,
  isOnline,
  nodeTimestamp,
  sortNodes,
  listNodes,
  unpairNode,
  disconnectNode,
  heartbeatNode,
  pickProxyNode,
};
