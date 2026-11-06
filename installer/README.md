# Instalador — Muse Spark → OpenCode

Automatiza a instalação completa do proxy como provider do **OpenCode Desktop (V2)**:

1. Escaneia os navegadores e extrai os cookies do `muse.ai`.
2. Valida a sessão no Muse.
3. Grava `muse.ai.cookies.json` e configura o `.env`, incluindo a `MUSE_PROXY_API_KEY` local.
4. Adiciona/atualiza o provider `muse/muse-spark` no `opencode.json` (contexto de 350.000 tokens, entrada de texto e imagem, raciocínio via `reasoning_content`, `settings.apiKey`).
5. Reinicia o proxy e espera o `/health`.

O instalador não tem dependências externas: usa `node:sqlite`, DPAPI do Windows e PowerShell.

## Uso rápido

```powershell
cd C:\muse-openai-proxy
.\installer\install.cmd
```

Com o navegador fechado (recomendado para Brave/Chrome/Edge):

```powershell
.\installer\install.cmd -CloseBrowsers
```

Direto pelo Node:

```powershell
node installer\install.js
```

Primeiro sem gravar nada:

```powershell
.\installer\install.cmd -DryRun
```

## Requisitos

- Windows (o scanner usa DPAPI e os caminhos dos navegadores).
- Node.js 22.5+ (instalador e proxy).
- **OpenCode Desktop 2.x** instalado. O instalador grava o schema V2 (`providers`), que o Desktop lê do `~/.config/opencode/opencode.json`. O terminal 1.x usa outro schema (`provider` singular) e não é configurado.
- Conta no Muse com sessão web ativa.

## De onde vêm os cookies

A ordem de escolha é:

1. `-HatchSess VALOR` / `--hatch-sess`.
2. `-Cookies CAMINHO` / `--cookies` (JSON exportado).
3. Escaneamento dos navegadores.
4. Fallback para a configuração já existente: `MUSE_COOKIES_FILE`, `muse.ai.cookies.json`, `MUSE_HATCH_SESS` ou `MUSE_COOKIE` do `.env`.

Na etapa 3 o instalador testa cada candidato em `https://muse.ai/api/session?vm_state=live` e usa o primeiro que autenticar. Se nenhum autenticar, ele tenta o fallback da etapa 4 antes de falhar.

### Navegadores suportados

Chromium (banco SQLite + DPAPI):

- Brave, Google Chrome, Chromium, Microsoft Edge, Vivaldi, Opera e Yandex.

Firefox (banco `cookies.sqlite`):

- Firefox, LibreWolf, Waterfox e Zen.

Todos os perfis são escaneados; cookies de outros domínios são descartados.

## O navegador precisa estar aberto?

Não. Para Brave/Chrome/Edge é melhor que esteja **fechado**: aberto, o Chromium mantém o banco `Cookies` bloqueado (`EBUSY`) e a leitura falha. O `-CloseBrowsers` fecha os navegadores abertos antes da leitura (o instalador não reabre; abra de novo depois).

Se preferir não fechar:

```powershell
.\installer\install.cmd -Cookies "C:\caminho\muse.ai.cookies.json"
```

ou

```powershell
.\installer\install.cmd -HatchSess "valor_do_cookie"
```

## App-Bound Encryption (`v20`)

Chrome/Edge/Brave recentes podem gravar os cookies com App-Bound Encryption (`v20`). O DPAPI comum não descriptografa esse formato:

- `v10`/`v11`: descriptografados com AES-256-GCM (com fallback CBC).
- `v20`: detectado e reportado; o instalador **não** grava um valor inválido.

Nesse caso, exporte os cookies manualmente para JSON e use `-Cookies`, ou copie o `hatch_sess` e use `-HatchSess`.

## Flags

Wrapper PowerShell/`.cmd` (`install.ps1`):

| Flag | Para que serve |
| --- | --- |
| `-DryRun` | Mostra o que seria feito; não grava nem reinicia. |
| `-Cookies CAMINHO` | Usa um JSON de cookies exportado. |
| `-HatchSess VALOR` | Usa um valor de `hatch_sess`. |
| `-CloseBrowsers` | Fecha os navegadores antes de ler os bancos. |
| `-NoProvider` | Não altera o `opencode.json`. |
| `-NoStart` | Não inicia/reinicia o proxy. |
| `-Smoke` | Envia uma mensagem curta de teste pelo proxy. |
| `-CheckThreads` | Lista threads extras no Muse. |
| `-ProxyUrl URL` | `baseURL` do provider (padrão `http://127.0.0.1:8790/v1`). |

Com `node installer/install.js`, use `--dry-run`, `--cookies`, `--hatch-sess`, `--close-browsers`, `--no-provider`, `--no-start`, `--smoke`, `--check-threads` e `--proxy-url`.

Exemplos:

```powershell
# validar tudo sem tocar no navegador nem no proxy
node installer\install.js --dry-run --cookies "C:\Users\SeuUsuario\Downloads\muse.ai.cookies.json"

# instalar sem mexer no provider do OpenCode
node installer\install.js --no-provider

# instalar, testar uma resposta e conferir threads
node installer\install.js --smoke --check-threads
```

## O que é alterado

- `muse.ai.cookies.json`: cookies filtrados do `muse.ai` (backup `.bak-<timestamp>` antes de sobrescrever).
- `.env`: `MUSE_COOKIES_FILE`, `MUSE_SESSION_MODE=request`, `MUSE_KEEP_SESSIONS=false`, `MUSE_REASONING_MODE=summary` e `MUSE_PROXY_API_KEY` (gerada se ausente; backup `.env.bak-<timestamp>`). As chaves antigas `MUSE_HATCH_SESS`, `MUSE_HATCH_GW`, `MUSE_HATCH_VML` e `MUSE_COOKIE` são comentadas para não competir com o arquivo de cookies.
- `opencode.json` global: provider `muse` mesclado com `input: ["text", "image"]`, `capabilities.reasoning.supported: true`, `compatibility.reasoningField: "reasoning_content"` e `settings.apiKey`; outros providers são preservados (backup ao lado do arquivo).
- `.muse-proxy-key`: fallback criado pelo proxy quando `MUSE_PROXY_API_KEY` não existe; ignorado pelo git. O instalador não o altera.
- `.muse-device.json`: criado pelo proxy em runtime com o UUID estável das device commands; o instalador não o altera. Ele é ignorado pelo git.
- Proxy: o processo anterior é parado **somente se** for identificado como este proxy (linha de comando contém `server.js` e o caminho do projeto). Outro processo na porta gera erro e não é morto.

Tudo é idempotente: se o conteúdo já está igual, o arquivo não é reescrito e nenhum backup novo é criado.

## Verificação

```powershell
Invoke-RestMethod http://127.0.0.1:8790/health
```

O retorno deve incluir:

```json
{
  "ok": true,
  "sessionMode": "request",
  "keepSessions": false,
  "images": true,
  "tools": ["workspace.list", "workspace.read", "workspace.write", "workspace.edit", "workspace.glob", "workspace.grep", "shell.exec"]
}
```

Teste completo:

```powershell
.\installer\install.cmd -Smoke -CheckThreads
```

`-Smoke` envia “Responda apenas: OK” e `-CheckThreads` confirma que nenhuma thread extra ficou no Muse (fora a sessão primária). Para validar imagens de verdade, com o proxy rodando:

```powershell
npm run test:image
```

O teste gera um PNG vermelho em memória e exige que o Muse responda “vermelho”. Nada é gravado em disco.

## Troubleshooting

**`EBUSY` / banco bloqueado**

Feche o navegador e rode com `-CloseBrowsers`.

**`Nenhum cookie hatch_sess encontrado`**

O navegador não tem sessão do Muse no perfil escaneado, ou o banco está bloqueado. Abra o Muse e faça login, feche o navegador e repita. Se o cookie estiver em outro perfil/conta, exporte o JSON.

**`Os cookies encontrados não autenticaram no Muse`**

A sessão expirou ou o cookie é de outra conta. Renove no navegador. Se o navegador usa `v20`, use `-Cookies` ou `-HatchSess`.

**`v20` / App-Bound Encryption**

Exporte manualmente o JSON de cookies ou informe o `hatch_sess`. O instalador avisa e não tenta gravar um cookie inválido.

**`node:sqlite não está disponível`**

Atualize para Node.js 22.5+ (recomendado 26). O scanner de navegadores precisa desse módulo.

**`401 invalid proxy API key`**

O proxy exige a chave gerada no `.env` (`MUSE_PROXY_API_KEY`). Rode `node installer\install.js` de novo para regravar `settings.apiKey` no provider, ou copie a chave para o cliente manual. Se a chave não existir, o proxy usa `.muse-proxy-key`.

**A porta 8790 está ocupada por outro processo**

O instalador não mata processos desconhecidos. Libere a porta ou troque `PORT` no `.env` e use `-ProxyUrl` com a nova URL.

**O OpenCode Desktop não mostra o modelo**

Confirme `http://127.0.0.1:8790/v1` no `baseURL` do provider e rode `npm run install:opencode`. O proxy precisa estar ativo para o `/v1/models` responder. O bloco precisa estar em `providers` (schema V2); feche e abra o Desktop depois de instalar. O terminal 1.x não lê esse schema.

**Apareceram vários nós “Muse Local Proxy”**

O proxy reutiliza o UUID de `.muse-device.json`, mas instalações antigas podem ter deixado registros. Liste e remova os offline/duplicados:

```powershell
npm run devices -- list
npm run devices -- prune --yes
```

`prune` preserva o device salvo e qualquer nó online; `unpair <id> --yes` remove um ID específico.

**Sobraram threads**

Rode `-CheckThreads`. No modo `request` as threads são apagadas no fim; `MUSE_KEEP_SESSIONS=true` as mantém de propósito. No modo `session`, uma thread por conversa é o esperado.

## Saída e código de retorno

O instalador termina com código `0` em caso de sucesso e diferente de `0` em erro (com a mensagem `[muse-install] ERRO: ...`). O `install.cmd` pausa no final quando é chamado sem argumentos, para você ler a saída.
