# Comece aqui

Guia curto para instalar o **Muse Spark** como provider do **OpenCode Desktop 2.x** no Windows.

## 1. Pré-requisitos

- Windows 10/11.
- **Node.js 22.5 ou superior** (`node --version`; se não tiver, instale a versão LTS em <https://nodejs.org>).
- **OpenCode Desktop 2.x** instalado.
- Conta no **Muse** com sessão web ativa no navegador (`https://muse.ai`).

> O terminal do OpenCode 1.x não é suportado: ele usa outro formato de configuração. Use o Desktop 2.x.

## 2. Descompactar

Extraia o ZIP para uma pasta simples, por exemplo:

```text
C:\muse-openai-proxy
```

Evite OneDrive e caminhos com muitos espaços.

## 3. Fechar o navegador do Muse

Para Brave, Chrome, Edge, Vivaldi, Opera e Yandex, o banco de cookies fica bloqueado com o navegador aberto. Feche-o antes de instalar (ou use `-CloseBrowsers` no passo 4).

## 4. Rodar o instalador

Abra o **PowerShell** na pasta e execute:

```powershell
cd C:\muse-openai-proxy
.\installer\install.cmd
```

O instalador vai:

1. instalar a dependência `ws` (`npm ci`);
2. procurar e validar os cookies do Muse nos navegadores;
3. gravar `muse.ai.cookies.json` e o `.env`, incluindo uma API key local automática;
4. adicionar o provider `muse/muse-spark` no OpenCode Desktop, com a API key e o raciocínio habilitado;
5. iniciar o proxy e esperar `http://127.0.0.1:8790/health` responder.

Se o navegador usa proteção `v20` ou os cookies não forem encontrados, use uma destas opções:

```powershell
# JSON de cookies exportado
.\installer\install.cmd -Cookies "C:\caminho\muse.ai.cookies.json"

# valor do cookie hatch_sess
.\installer\install.cmd -HatchSess "cole_o_valor_do_cookie"
```

Para só conferir o que seria feito, sem gravar nada:

```powershell
.\installer\install.cmd -DryRun
```

## 5. Abrir o OpenCode Desktop

Feche e abra o **OpenCode Desktop**. Selecione o modelo **Muse Spark** (`muse/muse-spark`) e mande uma mensagem.

Teste rápido do proxy:

```powershell
Invoke-RestMethod http://127.0.0.1:8790/health
```

O retorno deve conter `ok: true`, `images: true`, `sessionMode: "request"`, `reasoning: "summary"` e 7 ferramentas. O `/health` é público; as rotas `/v1/*` exigem a chave gravada no `.env`.

## 6. Raciocínio (thinking)

O Muse **não expõe chain-of-thought nativo** pela sessão web. O proxy ativa por padrão o modo `summary`: ele pede ao próprio modelo um resumo curto do raciocínio, separa esse resumo da resposta e o entrega ao OpenCode como `reasoning_content`. No Desktop, o bloco de “thinking” aparece normalmente; no CLI 2.x, use `--thinking` para vê-lo.

```powershell
# ver o raciocínio no CLI 2.x
opencode-cli run --thinking -m muse/muse-spark "sua pergunta"
```

O resumo é gerado pelo modelo, não é o raciocínio interno bruto. Para desligar e voltar ao comportamento antigo (só a resposta final), edite o `.env` e reinicie o proxy:

```dotenv
MUSE_REASONING_MODE=off
```

## 7. Se algo falhar

- **Nenhum cookie encontrado**: abra o Muse no navegador, faça login, feche o navegador e repita. Ou use `-Cookies` / `-HatchSess`.
- **Cookies não autenticaram**: a sessão expirou; renove no navegador.
- **Modelo não aparece no Desktop**: confirme o provider em `~/.config/opencode/opencode.json` (bloco `providers`) e reinicie o Desktop. Rode `npm run install:opencode` se precisar.
- **Porta 8790 ocupada**: libere a porta ou troque `PORT` no `.env`.
- **Threads sobrando no Muse**: rode `.\installer\install.cmd -CheckThreads`. No modo `request` elas são apagadas no fim.

Documentação completa: [README.md](README.md) e [installer/README.md](installer/README.md).

## Aviso

O proxy usa a sessão **web gratuita** do Muse, não a API paga. Ele não é oficial e pode parar de funcionar quando a Meta mudar o gateway.

As ferramentas `workspace.*` e `shell.exec` rodam **de verdade na sua máquina** — `shell.exec` não é um sandbox. Use apenas em projetos com os quais você pode trabalhar e mantenha backups.
