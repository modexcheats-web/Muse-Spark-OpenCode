'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const DEFAULT_BASE_URL = process.env.MUSE_PROXY_URL || 'http://127.0.0.1:8790/v1';
const PROVIDER_ID = 'muse';
const MODEL_ID = 'muse-spark';
const CONTEXT_WINDOW = 350000;
const MAX_OUTPUT = 16000;
const REASONING_FIELD = 'reasoning_content';

function configPath() {
  if (process.env.OPENCODE_CONFIG) return process.env.OPENCODE_CONFIG;
  const configHome =
    process.env.XDG_CONFIG_HOME ||
    path.join(process.env.USERPROFILE || process.env.HOME || '.', '.config');
  return path.join(configHome, 'opencode', 'opencode.json');
}

function readLocalApiKey() {
  if (process.env.MUSE_PROXY_API_KEY) return process.env.MUSE_PROXY_API_KEY.trim();
  const root = path.join(__dirname, '..');
  try {
    const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const match = text.match(/^\s*MUSE_PROXY_API_KEY\s*=\s*(.*)$/m);
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, '');
      if (value) return value;
    }
  } catch {
    /* no .env yet */
  }
  try {
    return fs.readFileSync(path.join(root, '.muse-proxy-key'), 'utf8').trim();
  } catch {
    return '';
  }
}

function providerConfig(baseURL = DEFAULT_BASE_URL, apiKey = '') {
  const settings = { baseURL };
  if (apiKey) settings.apiKey = apiKey;
  return {
    name: 'Muse Spark (local web session)',
    package: '@opencode/ai/providers/openai-compatible',
    settings,
    models: {
      [MODEL_ID]: {
        name: 'Muse Spark',
        modelID: MODEL_ID,
        capabilities: {
          tools: true,
          input: ['text', 'image'],
          output: ['text'],
          reasoning: { supported: true },
        },
        compatibility: { reasoningField: REASONING_FIELD },
        limit: { context: CONTEXT_WINDOW, output: MAX_OUTPUT },
      },
    },
  };
}

/**
 * Merges the Muse provider into an existing OpenCode config.
 *
 * The provider is updated in place so a previous install (for example one with
 * the old 128k context limit) is upgraded instead of being skipped. Other
 * providers and unrelated fields are preserved.
 */
function mergeProvider(existing, baseURL = DEFAULT_BASE_URL, apiKey = '') {
  const current =
    existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const desired = providerConfig(baseURL, apiKey);
  const currentModel =
    current.models && typeof current.models === 'object' ? current.models[MODEL_ID] : null;

  return {
    ...current,
    ...desired,
    settings: {
      ...(current.settings && typeof current.settings === 'object' ? current.settings : {}),
      ...desired.settings,
    },
    models: {
      ...(current.models && typeof current.models === 'object' ? current.models : {}),
      [MODEL_ID]: {
        ...(currentModel && typeof currentModel === 'object' ? currentModel : {}),
        ...desired.models[MODEL_ID],
        capabilities: {
          ...(currentModel && typeof currentModel.capabilities === 'object'
            ? currentModel.capabilities
            : {}),
          ...desired.models[MODEL_ID].capabilities,
        },
        compatibility: {
          ...(currentModel && typeof currentModel.compatibility === 'object'
            ? currentModel.compatibility
            : {}),
          ...desired.models[MODEL_ID].compatibility,
        },
        limit: {
          ...(currentModel && typeof currentModel.limit === 'object' ? currentModel.limit : {}),
          ...desired.models[MODEL_ID].limit,
        },
      },
    },
  };
}

function installProvider({
  file = configPath(),
  baseURL = DEFAULT_BASE_URL,
  apiKey = '',
  dryRun = false,
  logger = console,
} = {}) {
  const exists = fs.existsSync(file);
  let parsed;
  let originalText = null;

  if (exists) {
    originalText = fs.readFileSync(file, 'utf8');
    try {
      parsed = JSON.parse(originalText);
    } catch (e) {
      throw new Error(
        `Não consegui ler ${file} como JSON: ${e.message}. ` +
          'Se o arquivo tiver comentários (JSONC), remova-os ou adicione o provider manualmente.'
      );
    }
  } else {
    parsed = { $schema: 'https://opencode.ai/config.json' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`O conteúdo de ${file} não é um objeto JSON válido.`);
  }
  if (parsed.provider && typeof parsed.provider === 'object' && !Array.isArray(parsed.provider)) {
    logger.warn?.(
      `${file} também tem o schema antigo "provider". O Desktop 2.x usa "providers"; ` +
        'o bloco antigo é preservado, mas o terminal 1.x não verá o provider novo.'
    );
  }
  if (parsed.providers == null) parsed.providers = {};
  if (typeof parsed.providers !== 'object' || Array.isArray(parsed.providers)) {
    throw new Error(`O campo "providers" de ${file} não é um objeto.`);
  }

  const beforeProvider = parsed.providers[PROVIDER_ID];
  const nextProvider = mergeProvider(beforeProvider, baseURL, apiKey);
  const changed = !exists || !isDeepStrictEqual(beforeProvider, nextProvider);
  parsed.providers[PROVIDER_ID] = nextProvider;
  const nextText = JSON.stringify(parsed, null, 2) + '\n';

  if (!changed) {
    logger.log?.(`Provider "${PROVIDER_ID}" já está atualizado em ${file}`);
    return {
      file,
      changed: false,
      created: false,
      backup: null,
      dryRun,
      provider: parsed.providers[PROVIDER_ID],
    };
  }

  if (dryRun) {
    logger.log?.(`[dry-run] Atualizaria o provider "${PROVIDER_ID}" em ${file}`);
    return {
      file,
      changed: true,
      created: !exists,
      backup: null,
      dryRun: true,
      provider: parsed.providers[PROVIDER_ID],
    };
  }

  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let backup = null;
  if (exists) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  }

  // Re-parse before writing to avoid ever leaving invalid JSON behind.
  JSON.parse(nextText);
  fs.writeFileSync(file, nextText, { mode: 0o600 });

  logger.log?.(`Provider "${PROVIDER_ID}" (${MODEL_ID}) atualizado em ${file}`);
  return {
    file,
    changed: true,
    created: !exists,
    backup,
    dryRun: false,
    provider: parsed.providers[PROVIDER_ID],
  };
}

function parseCli(argv) {
  const options = {
    dryRun: false,
    baseURL: DEFAULT_BASE_URL,
    file: configPath(),
    apiKey: readLocalApiKey(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--base-url') options.baseURL = argv[++i];
    else if (arg === '--config') options.file = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return options;
}

if (require.main === module) {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (options.help) {
    console.log('Uso: node scripts/install-opencode-provider.js [--dry-run] [--config CAMINHO]');
    process.exit(0);
  }
  try {
    const result = installProvider(options);
    console.log(`baseURL: ${result.provider.settings.baseURL}`);
    console.log(`contexto: ${result.provider.models[MODEL_ID].limit.context} tokens`);
    console.log(
      `raciocínio: ${result.provider.models[MODEL_ID].compatibility.reasoningField}`
    );
    console.log(
      result.provider.settings.apiKey
        ? 'API key: configurada em settings.apiKey'
        : 'API key: ausente (rode o instalador ou defina MUSE_PROXY_API_KEY)'
    );
    if (result.backup) console.log(`backup:  ${result.backup}`);
    console.log(
      `No OpenCode Desktop, abra o seletor de modelos e escolha Muse Spark (${PROVIDER_ID}/${MODEL_ID}).`
    );
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  PROVIDER_ID,
  MODEL_ID,
  CONTEXT_WINDOW,
  MAX_OUTPUT,
  REASONING_FIELD,
  configPath,
  readLocalApiKey,
  providerConfig,
  mergeProvider,
  installProvider,
};
