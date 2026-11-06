#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadDotEnv, resolveCookie } = require('../src/env');
const { MuseGateway } = require('../src/muse-gateway');
const {
  listNodes,
  unpairNode,
  isUuid,
  PROXY_DISPLAY_NAME,
} = require('../src/muse-nodes');

const DEVICE_FILE = path.join(process.cwd(), '.muse-device.json');

function usage() {
  console.log(`Uso:
  node scripts/muse-devices.js list [--json]
  node scripts/muse-devices.js prune [--yes] [--keep <node_id>]
  node scripts/muse-devices.js unpair <node_id> [--yes]

Por padrão, prune apenas simula a remoção. Use --yes para remover de verdade.
prune só considera nós com display_name "${PROXY_DISPLAY_NAME}" e nunca remove
um nó online ou o device salvo em .muse-device.json.`);
}

function parseArgs(argv) {
  const options = { command: 'list', yes: false, json: false, keep: [], ids: [], help: false };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('--')) options.command = args.shift();
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--keep') options.keep.push(args.shift());
    else if (arg === '--id') options.ids.push(args.shift());
    else if (!arg.startsWith('--') && options.command === 'unpair') options.ids.push(arg);
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return options;
}

function savedDeviceId() {
  try {
    const data = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'));
    const id = data?.device_id ?? data?.deviceId;
    return isUuid(id) ? id : null;
  } catch {
    return null;
  }
}

function describe(node) {
  return {
    id: node.node_id || '(sem id)',
    valid: isUuid(node.node_id),
    display: node.display_name || '',
    state: node.connection_state || (node.online ? 'online' : 'offline'),
    online: node.online === true,
    paired: String(node.paired_at || '').replace('T', ' ').slice(0, 19),
    lastSeen: String(node.last_seen_at || '').replace('T', ' ').slice(0, 19),
    commands: Object.keys(node.commands_v2 || {}).length,
  };
}

function printNodes(nodes) {
  if (nodes.length === 0) {
    console.log('Nenhum nó encontrado.');
    return;
  }
  const rows = nodes.map(describe);
  const width = Math.max(36, ...rows.map((row) => row.id.length));
  console.log(
    `${'NODE ID'.padEnd(width)}  ${'ESTADO'.padEnd(7)}  ${'UUID'.padEnd(5)}  ` +
      `${'CMD'.padStart(3)}  ${'PAIRED'.padEnd(19)}  DISPLAY`
  );
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(width)}  ${row.state.padEnd(7)}  ${String(row.valid).padEnd(5)}  ` +
        `${String(row.commands).padStart(3)}  ${row.paired.padEnd(19)}  ${row.display}`
    );
  }
}

function isRemovableProxyNode(node, keep) {
  if (node.display_name !== PROXY_DISPLAY_NAME) return false;
  if (keep.has(node.node_id)) return false;
  if (node.online === true || node.connection_state === 'online') return false;
  return true;
}

async function run() {
  loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }

  const gateway = new MuseGateway({ cookie: resolveCookie() });
  gateway.on('protocol-error', (e) => console.warn('[muse] protocol error:', e.message));
  gateway.on('socket-error', (e) => console.warn('[muse] socket error:', e.message));

  try {
    await gateway.connect();
    const nodes = await listNodes(gateway);

    if (options.command === 'list') {
      if (options.json) {
        console.log(JSON.stringify({ nodes }, null, 2));
      } else {
        printNodes(nodes);
        const saved = savedDeviceId();
        if (saved) console.log(`\nDevice salvo em ${DEVICE_FILE}: ${saved}`);
        console.log(
          `\nNós "${PROXY_DISPLAY_NAME}": ${nodes.filter((node) => node.display_name === PROXY_DISPLAY_NAME).length}`
        );
      }
      return 0;
    }

    if (options.command === 'unpair') {
      const requested = options.ids.filter(Boolean);
      if (requested.length === 0) throw new Error('Informe o node_id para unpair.');
      const saved = savedDeviceId();
      for (const id of requested) {
        if (id === saved) {
          console.error(`Recusando remover o device atual salvo em ${DEVICE_FILE}: ${id}`);
          return 1;
        }
        const node = nodes.find((item) => item.node_id === id);
        if (!node) console.warn(`Aviso: ${id} não está na lista atual de nós.`);
        if (!options.yes) {
          console.log(`[dry-run] Removeria o nó ${id}${node ? ` (${node.display_name})` : ''}.`);
          continue;
        }
        const res = await unpairNode(gateway, id);
        console.log(`unpair ${id}: status=${res.status} ${JSON.stringify(res.json || {})}`);
      }
      if (!options.yes) console.log('\nNada foi alterado. Repita com --yes para remover.');
      return 0;
    }

    if (options.command === 'prune') {
      const keep = new Set([...options.keep.filter(Boolean), savedDeviceId()].filter(Boolean));
      const removable = nodes.filter((node) => isRemovableProxyNode(node, keep));
      if (removable.length === 0) {
        console.log('Nenhum nó duplicado/offline para remover.');
        return 0;
      }
      console.log('Nós que serão removidos:');
      printNodes(removable);
      if (!options.yes) {
        console.log('\n[dry-run] Nada foi alterado. Repita com --yes para remover.');
        return 0;
      }
      for (const node of removable) {
        const res = await unpairNode(gateway, node.node_id);
        console.log(`unpair ${node.node_id}: status=${res.status} ${JSON.stringify(res.json || {})}`);
      }
      return 0;
    }

    throw new Error(`Comando desconhecido: ${options.command}`);
  } finally {
    gateway.close();
  }
}

run()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[muse-devices] ${e.message}`);
    process.exit(1);
  });
