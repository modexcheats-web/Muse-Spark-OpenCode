# Muse Spark → OpenAI proxy

Proxy local que expõe a sessão web gratuita do **Meta Muse Spark** como uma API compatível com OpenAI, para usar como provider do OpenCode.

O detalhe importante: neste proxy o Muse **executa as ferramentas de verdade na sua máquina**. Em vez de fingir `tool_calls` da OpenAI (o Muse recusa esse protocolo), o proxy registra `workspace.*` e `shell.exec` como **device commands nativas** do Muse. O agente chama esses comandos, o proxy executa no projeto local e devolve o resultado para ele continuar o raciocínio. No fim, o OpenCode recebe apenas o texto final.

Isso significa que você não precisa de plugin de arquivos no OpenCode: o Muse lê, edita, cria e roda comandos no seu projeto real. O workspace da VM do Muse não é usado para isso.

> Projeto não oficial. Usa a sessão web do Muse (`hatch_sess`), pode parar de funcionar quando a Meta mudar o gateway e está sujeito aos limites da conta gratuita. Não use com dados dos quais você não pode perder uma cópia.

## Requisitos

- Node.js 22.5 ou superior (proxy, testes e instalador; o instalador usa `node:sqlite` para ler os cookies).
- Uma conta no Muse com sessão web ativa.
- **OpenCode Desktop 2.x (V2)** para a integração pronta. O instalador grava o schema V2 (`providers`); o terminal 1.x usa `provider` (singular) e não lê esse bloco. O proxy em si funciona com qualquer cliente OpenAI-compatible.

## Instalação rápida (recomendada)

O instalador procura os cookies do Muse nos navegadores, valida a sessão, grava o arquivo de cookies, atualiza o `.env`, adiciona o provider no OpenCode e reinicia o proxy.

```powershell
cd C:\muse-openai-proxy
.\installer\install.cmd
```

Ou, sem o wrapper:

```powershell
node installer\install.js
```

O instalador:

1. Escaneia Brave, Chrome, Chromium, Edge, Vivaldi, Opera, Yandex, Firefox, LibreWolf, Waterfox e Zen, em todos os perfis.
2. Descriptografa os cookies do Chromium (`v10`/`v11`) e do Firefox, filtrando o domínio `muse.ai`.
3. Valida o `hatch_sess` em `https://muse.ai/api/session?vm_state=live`.
4. Grava `muse.ai.cookies.json` e aponta `MUSE_COOKIES_FILE` no `.env`.
5. Define `MUSE_SESSION_MODE=request`, `MUSE_KEEP_SESSIONS=false` e `MUSE_REASONING_MODE=summary` (a menos que você mude depois).
6. Gera uma `MUSE_PROXY_API_KEY` local (se ainda não existir) e grava no `.env`.
7. Instala/atualiza o provider `muse/muse-spark` no `opencode.json`, com contexto de **350.000 tokens**, raciocínio via `reasoning_content` e a chave em `settings.apiKey`.
8. Reinicia o proxy e espera o `/health` responder.

Arquivos existentes são preservados: cada alteração cria um backup (`.env.bak-...`, `opencode.json.bak-...`, `muse.ai.cookies.json.bak-...`) e rodar de novo não reescreve o que já está igual.

### O navegador precisa estar aberto?

Não — e para o Brave/Chrome/Edge o ideal é que esteja **fechado**. Com o navegador aberto, o Chromium mantém o banco `Cookies` bloqueado (`EBUSY`) e o instalador não consegue ler. Use:

```powershell
.\installer\install.cmd -CloseBrowsers
```

O `-CloseBrowsers` fecha os navegadores abertos antes da leitura. Alternativas:

```powershell
# arquivo JSON exportado
.\installer\install.cmd -Cookies "C:\Users\SeuUsuario\Downloads\muse.ai.cookies.json"

# valor do cookie hatch_sess
.\installer\install.cmd -HatchSess "cole_o_valor_do_cookie"
```

### Flags do instalador

Com o wrapper PowerShell/`.cmd` (`install.ps1`):

| Flag | Para que serve |
| --- | --- |
| `-DryRun` | Mostra o que seria feito, sem gravar nem reiniciar nada. |
| `-Cookies CAMINHO` | Usa um JSON de cookies exportado. |
| `-HatchSess VALOR` | Usa um valor de `hatch_sess`. |
| `-CloseBrowsers` | Fecha os navegadores antes de ler os bancos. |
| `-NoProvider` | Não altera o `opencode.json`. |
| `-NoStart` | Não inicia/reinicia o proxy. |
| `-Smoke` | Envia uma mensagem curta de teste pelo proxy. |
| `-CheckThreads` | Lista threads extras no Muse. |
| `-ProxyUrl URL` | `baseURL` do provider (padrão `http://127.0.0.1:8790/v1`). |

Com `node installer/install.js`, use os equivalentes `--dry-run`, `--cookies`, `--hatch-sess`, `--close-browsers`, `--no-provider`, `--no-start`, `--smoke`, `--check-threads` e `--proxy-url`.

### App-Bound Encryption (`v20`)

Chrome/Edge/Brave recentes podem proteger os cookies com App-Bound Encryption (`v20`). O DPAPI comum não descriptografa esse formato; o instalador detecta, avisa e não grava um cookie inválido. Nesse caso exporte os cookies manualmente para JSON e use `-Cookies`, ou copie o `hatch_sess` e use `-HatchSess`.

### Instalação manual

```powershell
cd C:\muse-openai-proxy
npm ci
Copy-Item .env.example .env
```

Edite o `.env`:

```dotenv
PORT=8790
HOST=127.0.0.1
MUSE_MODEL=muse-spark
MUSE_TIMEOUT_MS=180000

# request = thread nova por requisicao (padrao)
# session = uma thread por conversa do OpenCode
# legacy  = sessao fixa de .muse-session.json
MUSE_SESSION_MODE=request
MUSE_KEEP_SESSIONS=false

# summary = resumo de raciocínio enviado como reasoning_content (padrão)
# off     = só a resposta final, sem raciocínio
MUSE_REASONING_MODE=summary

# Forma recomendada: arquivo JSON com os cookies do muse.ai.
MUSE_COOKIES_FILE=C:/muse-openai-proxy/muse.ai.cookies.json

# Alternativa: valor do cookie hatch_sess.
# MUSE_HATCH_SESS=cole_o_valor_do_cookie_hatch_sess

# Chave local exigida no header Authorization. Se vazio, o proxy gera
# .muse-proxy-key na primeira execucao. O instalador preenche automaticamente.
# MUSE_PROXY_API_KEY=troque-esta-chave

# false desabilita shell.exec (o resto continua funcionando).
MUSE_ENABLE_SHELL=true
```

O arquivo de cookies aceita uma lista:

```json
[
  { "name": "hatch_sess", "value": "..." },
  { "name": "hatch_gw", "value": "..." },
  { "name": "hatch_vml", "value": "..." }
]
```

ou um objeto `{ "hatch_sess": "...", "hatch_gw": "..." }`.

Para renovar a sessão: copie o novo `hatch_sess` do navegador, atualize o arquivo de cookies (ou rode o instalador de novo) e reinicie o proxy.

## Modos de sessão

O Muse mistura o contexto quando você alterna entre modelos e volta para ele. Para evitar isso, o proxy isola cada conversa em uma thread própria:

| Modo | Comportamento | Uso |
| --- | --- | --- |
| `request` (padrão) | Cria uma thread nova a cada requisição e apaga no fim. | Uso normal no OpenCode; zero mistura de contexto. |
| `session` | Cria uma thread por conversa do OpenCode e reutiliza nos turnos seguintes. | Quando você quer continuidade dentro da mesma conversa. |
| `legacy` | Reutiliza a sessão fixa de `.muse-session.json`. | Compatibilidade com o comportamento antigo. |

Detalhes:

- No modo `session`, a chave é derivada do workspace + primeira mensagem do usuário e fica em `.muse-sessions.json` (7 dias).
- No modo `request`, `.muse-session.json` **não** é atualizado; ele só é gravado no modo `legacy`.
- `MUSE_KEEP_SESSIONS=true` mantém as threads do modo `request` no Muse para depuração (não apaga no fim).
- A thread é criada pelo próprio `chat.stream` com UUID e apagada com `POST /api/session/delete`.

## Rodar

```powershell
npm start
```

Saída esperada:

```text
[muse] OpenAI-compatible proxy on http://127.0.0.1:8790/v1
[muse] model: muse-spark
[muse] session mode: request
[muse] reasoning: summary
[muse] workspace: C:\muse-openai-proxy
[muse] shell.exec: enabled
```

No modo `legacy` a linha do modelo mostra também `(session ...)`.

Confira o health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8790/health
```

Quando a primeira conversa conectar, o log deve mostrar:

```text
[muse] device commands accepted: 7
```

`accepted: 7`, `rejected_ids: []` significa que o Muse aceitou todas as ferramentas locais.

## Provider no OpenCode Desktop (V2)

O alvo suportado é o **OpenCode Desktop 2.x**. Ele carrega o mesmo `opencode.json` global que o instalador atualiza. Para instalar/atualizar só o provider:

```powershell
npm run install:opencode
```

Ele mescla o provider no `opencode.json` global **com backup**, sem mexer nos outros providers:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "muse": {
      "name": "Muse Spark (local web session)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8790/v1"
      },
      "models": {
        "muse-spark": {
          "name": "Muse Spark",
          "modelID": "muse-spark",
          "capabilities": {
            "tools": true,
            "input": ["text", "image"],
            "output": ["text"],
            "reasoning": { "supported": true }
          },
          "compatibility": {
            "reasoningField": "reasoning_content"
          },
          "limit": {
            "context": 350000,
            "output": 16000
          }
        }
      }
    }
  }
}
```

Se preferir, adicione o bloco `"muse"` manualmente dentro de `providers` no seu `~/.config/opencode/opencode.json`.

> Esse é o schema do **OpenCode V2**. O terminal 1.x usa `provider` (singular) e `npm`/`options`; ele não lê o bloco `providers`. Por isso o alvo suportado é o Desktop 2.x — o mesmo formato também é lido pelo CLI 2.x quando você quiser testar por linha de comando.

Depois, no **OpenCode Desktop**:

1. Abra o seletor de modelos da conversa.
2. Escolha **Muse Spark** (`muse/muse-spark`).
3. Peça algo como: “leia o package.json e me diga a versão”.

Se o modelo não aparecer, feche e abra o Desktop para ele recarregar o `opencode.json`.

### Imagens

O provider declara `input: ["text", "image"]`. O OpenCode envia a imagem como `image_url` com data URL; o proxy valida e repassa ao Muse no formato nativo `items`:

```json
{ "type": "image", "mime_type": "image/png", "data_base64": "...", "filename": "..." }
```

Limites: 8 MiB por imagem e 14 MiB no total por requisição (o cliente web do Muse recusa anexos inline acima de ~16 MiB). Apenas `data:image/...;base64,...` é aceito; URLs remotas são recusadas para o proxy não buscar conteúdo arbitrário. Para testar de verdade:

```powershell
npm run test:image
```

### Raciocínio (thinking)

O Muse **não expõe chain-of-thought nativo** pela sessão web (`GET /model` só oferece `auto/auto`, sem variante de raciocínio). O proxy usa um envelope de prompt:

1. quando `MUSE_REASONING_MODE=summary` (padrão), o prompt pede um resumo curto do raciocínio dentro de `<muse_reasoning>...</muse_reasoning>` e a resposta final dentro de `<muse_answer>...</muse_answer>`;
2. o proxy remove as tags e envia o resumo como `reasoning_content` (streaming e non-streaming);
3. o OpenCode declara `capabilities.reasoning.supported: true` e `compatibility.reasoningField: "reasoning_content"`, então mostra o bloco de raciocínio.

O resumo é **gerado pelo próprio modelo**, não é o raciocínio interno bruto nem um recurso oficial do Muse. Para desligar:

```dotenv
MUSE_REASONING_MODE=off
```

Reinicie o proxy depois de mudar. O `/health` mostra o modo atual em `reasoning`.

No CLI 2.x, use `--thinking` para exibir o bloco:

```powershell
& "$env:APPDATA\ai.opencode.desktop\cli\2.2.5-x64\opencode-cli.exe" run --thinking `
  --format json -m muse/muse-spark "Quanto e 23 * 47 - 19 * 12?"
```

O evento `reasoning` deve trazer `metadata.reasoningField: "reasoning_content"` e o texto final vem em um evento `text` separado.

Também é possível fixar no `opencode.json`:

```jsonc
{
  "model": "muse/muse-spark"
}
```

### Porta 8790

A porta padrão do proxy é **8790** de propósito: a 8787 já aparece no seu `opencode.json` para o provider `browser-bridge`. Não mude a porta sem atualizar o `baseURL` do provider `muse`.

Para usar outra porta:

```powershell
$env:PORT = "8791"; npm start
```

e ajuste `baseURL` no `opencode.json`. Se ainda não adicionou o provider, rode:

```powershell
$env:MUSE_PROXY_URL = "http://127.0.0.1:8791/v1"
npm run install:opencode
```

## Como o workspace é escolhido

O proxy resolve a raiz do projeto a cada requisição, nesta ordem:

1. `MUSE_WORKSPACE` do `.env`.
2. Header `x-muse-workspace`.
3. O `Working directory:` presente nas mensagens enviadas pelo OpenCode.
4. O diretório de onde o proxy foi iniciado.

O log mostra quando muda:

```text
[muse] workspace for this request: C:\seu\projeto
```

Todos os caminhos das device commands são resolvidos dentro dessa raiz. `..` e caminhos absolutos para fora dela são bloqueados.

## Device ID e nós duplicados

O proxy mantém um UUID estável em `.muse-device.json` (ignorado pelo git) e o usa como `node_id`/`client_id` das device commands. A resolução tenta, nesta ordem:

1. `MUSE_DEVICE_ID`, somente se for um UUID válido.
2. O UUID salvo em `.muse-device.json`.
3. Um nó existente com `display_name` **Muse Local Proxy**.
4. Um UUID novo.

O histórico da conversa não é mais usado: ele podia devolver o ID de outro cliente do navegador. Para inspecionar e limpar registros antigos:

```powershell
npm run devices -- list
npm run devices -- prune           # dry-run
npm run devices -- prune --yes     # remove nós offline/duplicados do proxy
npm run devices -- unpair <node_id> --yes
```

`prune` nunca remove um nó online nem o device salvo; `unpair` recusa o device atual.

## Device commands disponíveis

| Comando | Para que serve |
| --- | --- |
| `workspace.list` | Listar uma pasta do projeto. |
| `workspace.read` | Ler texto (200 linhas por padrão, máximo 2000) com `offset`/`limit`, ou binário com `encoding: "base64"`. |
| `workspace.write` | Criar ou sobrescrever um arquivo. |
| `workspace.edit` | Substituir texto exato, com `replace_all` opcional. |
| `workspace.glob` | Achar arquivos por glob (`**/*.ts`), com `offset`/`limit`, `total` e `has_more`. |
| `workspace.grep` | Buscar conteúdo com expressão regular, com `offset`/`limit`, `total_matches`, `complete` e `truncated_reasons`. |
| `shell.exec` | Rodar testes, builds, git e comandos do projeto. |

Limites contra uso acidental (todos explícitos no resultado):

| Limite | Valor |
| --- | --- |
| Leitura de texto | 512 KiB por chamada; 200 linhas padrão, 2000 máximo |
| Leitura base64 | 32 KiB por página (máximo 128 KiB); use `next_offset` para continuar |
| Escrita | 5 MiB |
| Glob | 200 resultados padrão, 2000 máximo; varre até 10.000 arquivos |
| Grep | 100 resultados padrão, 500 máximo; 5.000 arquivos, 20 MiB e 1 MiB por arquivo |
| Shell | 1 MiB de saída; timeout de 5 minutos |

`workspace.grep` só marca `truncated: true` quando um limite foi realmente atingido e informa o motivo em `truncated_reason`/`truncated_reasons`. Com `include`, a varredura e a contagem consideram só os arquivos que casam com o filtro. `workspace.glob` e `workspace.grep` retornam `next_offset` quando há mais páginas. Leitura base64 também pagina por bytes (`offset` + `next_offset`), sem despejar o arquivo inteiro no contexto.

`node_modules`, `.git`, `dist`, `build` etc. são ignorados em glob/grep.

`MUSE_ENABLE_SHELL=false` remove o `shell.exec`; o Muse continua podendo ler e editar arquivos.

## Segurança

- O proxy escuta em `127.0.0.1` por padrão. Não exponha na rede sem entender que o Muse poderá executar comandos na sua máquina.
- Por padrão o proxy exige `Authorization: Bearer <chave>`. O instalador gera a chave no `.env` e grava em `settings.apiKey` do provider. Sem `MUSE_PROXY_API_KEY`, o proxy gera `.muse-proxy-key` na primeira execução.
- CORS fica desligado por padrão: páginas web não conseguem chamar o proxy. Se precisar de um cliente no navegador, liste as origens em `MUSE_CORS_ORIGINS`; evite `*`.
- `shell.exec` **não é sandbox**. `cwd` só define o diretório inicial; o comando pode ler e escrever fora do projeto, com o mesmo usuário do proxy. Desabilite se não quiser esse risco.
- Variáveis `MUSE_*` (incluindo cookies e `MUSE_PROXY_API_KEY`) são removidas do ambiente dos comandos, para que código do projeto não as leia.
- Os cookies ficam só no seu `.env`/arquivo local. Não versione o `.env`, o arquivo de cookies, `.muse-proxy-key` nem `.muse-device.json`.
- Imagens só são aceitas como data URL; o proxy não baixa URLs remotas.
- O proxy não envia seus arquivos para lugar nenhum além do próprio Muse, que já é o modelo que você está usando.

## Testes manuais

Com o proxy rodando:

```powershell
npm run test:openai -- plain      # resposta simples
npm run test:openai -- stream     # streaming SSE
npm run test:openai -- workspace  # lê package.json via device command
npm run test:openai -- edit       # cria, edita, lê e apaga um arquivo real
npm run test:image                # envia um PNG vermelho real e confere a resposta
npm run test:reasoning            # parser do envelope e formato do prompt (sem o Muse)
npm run test:tools                # ferramentas locais, sem o Muse
npm run devices -- list           # lista os nós/device IDs do Muse
```

O teste `edit` cria `.muse-test.txt` na raiz do proxy, edita, mostra o conteúdo e apaga. O `test:image` gera o PNG em memória (nada é gravado) e faz uma requisição real ao Muse; a resposta precisa conter “vermelho”. O `test:reasoning` cobre tags `<muse_reasoning>`/`<muse_answer>`, tags genéricas, envelope incompleto e a instrução de formato do prompt. O `test:tools` cobre paginação de glob/grep e de leitura base64, além da remoção de `MUSE_*` do ambiente do shell.

Para testar com o OpenCode V2 instalado pelo app:

```powershell
& "$env:APPDATA\ai.opencode.desktop\cli\2.2.5-x64\opencode-cli.exe" run --standalone --thinking `
  --model muse/muse-spark "Leia o package.json e diga apenas name e version."
```

Para validar a instalação inteira, rode `.\installer\install.cmd -Smoke -CheckThreads`: ele envia uma mensagem curta e confere se sobrou thread no Muse.

## Limitações

- É uma sessão web, não a API oficial: sem garantia de disponibilidade, rate limit ou estabilidade.
- O proxy atende **uma requisição por vez** por sessão do Muse. Requisições concorrentes entram numa fila.
- Texto e imagens (data URL, até os limites acima). Áudio, vídeo e anexos de arquivo ainda não são encaminhados.
- `workspace.grep` não lê arquivos maiores que 1 MiB; o resultado informa `files_skipped_large` e marca a busca como incompleta.
- O OpenCode não recebe `tool_calls` nativos da OpenAI; o loop de ferramentas acontece dentro do Muse, e o resultado chega como texto final.
- O raciocínio é um **resumo gerado pelo modelo** (modo `summary`), não chain-of-thought nativo do Muse; desligue com `MUSE_REASONING_MODE=off`.
- O Muse tem ferramentas próprias da VM dele. O prompt do proxy deixa claro que o projeto real está nas device commands, mas ele pode ocasionalmente tentar o workspace da VM primeiro; se isso acontecer, seja explícito (“use `workspace.read` no projeto local”).
- `.muse-session.json` só é usado no modo `legacy`; nos modos `request` e `session` ele não aponta para threads descartáveis.
- Se a Meta mudar o protocolo do gateway, o proxy pode precisar de ajuste.

## Problemas comuns

**`Muse web session expired or invalid`**

O `hatch_sess` expirou. Rode o instalador de novo ou copie um novo do navegador e reinicie o proxy.

**O instalador não encontra cookies / `EBUSY`**

Feche o navegador e rode de novo com `-CloseBrowsers`. Se o navegador usa App-Bound Encryption (`v20`), exporte o JSON manualmente e use `-Cookies`.

**`device commands accepted: 0` ou comandos rejeitados**

O proxy usa um UUID estável em `.muse-device.json` e registra o nó **Muse Local Proxy**. Rode `npm run devices -- list` para conferir o ID usado e se há nós duplicados; `npm run devices -- prune --yes` remove os offline. Só defina `MUSE_DEVICE_ID` se precisar forçar um UUID válido — IDs malformados são ignorados com aviso no log.

**O Muse diz que não encontrou o arquivo**

Confira no log `[muse] workspace for this request: ...`. Se estiver errado, defina `MUSE_WORKSPACE` no `.env` com o caminho absoluto do projeto.

**O OpenCode Desktop não lista o modelo**

Rode `npm run install:opencode` de novo e confira se o `baseURL` é `http://127.0.0.1:8790/v1`, e se o bloco está em `providers` (schema V2). Feche e abra o Desktop para recarregar. O terminal 1.x não mostra esse provider porque usa `provider` (singular); use o Desktop 2.x ou o CLI 2.x.

**O bloco de raciocínio não aparece no OpenCode**

Confirme `MUSE_REASONING_MODE=summary` no `.env` e `reasoning: "summary"` no `/health`. Rode `npm run install:opencode` para regravar `capabilities.reasoning` e `compatibility.reasoningField` no provider e reinicie o OpenCode. No CLI 2.x, sem `--thinking` o bloco é ocultado de propósito. O resumo depende do modelo obedecer ao envelope; se ele responder sem as tags, o proxy entrega só o texto como conteúdo.

**Sobraram threads no Muse**

Use `-CheckThreads` para listar. Threads do modo `request` são apagadas no fim; se você usou `MUSE_KEEP_SESSIONS=true`, elas ficam de propósito. O modo `session` mantém uma por conversa.

**`401 invalid proxy API key`**

O proxy exige `MUSE_PROXY_API_KEY`. Rode o instalador de novo para regravar `settings.apiKey` no provider ou copie a chave do `.env` para o cliente manual. Se a chave não existir, o proxy usa `.muse-proxy-key`.

**`fatal: not a git repository`**

O `shell.exec` roda no workspace escolhido, mas não cria repositório. Se o projeto não tem `.git`, comandos `git` falham normalmente; rode `git init` no projeto ou execute o comando em outro diretório. O proxy não bloqueia `shell.exec` fora do workspace — isso é intencional e documentado.

**`EADDRINUSE` na 8790**

Já existe um proxy rodando. Feche o processo antigo ou use outra porta e atualize o provider.

## Estrutura

```text
src/muse-gateway.js      transporte Noise/AES até o gateway web do Muse
src/muse-chat.js         sessão, correlação de turnos, device commands e streaming
src/muse-nodes.js        lista/seleção/remoção de nós (device IDs) do Muse
src/env.js               carregamento do .env e resolução dos cookies
src/images.js            validação e conversão de imagens para o formato do Muse
src/session-store.js     mapa conversa -> thread no modo session
src/tools.js             ferramentas locais (workspace.* e shell.exec)
src/prompt.js            montagem do prompt para o Muse
src/reasoning.js         parser do envelope de raciocínio e resposta
src/server.js            servidor OpenAI-compatible (/v1/models, /v1/chat/completions)
installer/               instalador: cookies de navegador, .env, provider e restart
scripts/                 testes, device IDs e instalador do provider do OpenCode
```

Instruções detalhadas do instalador (flags, recuperação e troubleshooting) estão em [`installer/README.md`](installer/README.md).
