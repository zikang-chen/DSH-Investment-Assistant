# 让 Windows 上的 PowerShell 不再反复出问题（彻底方案）

本仓库出现过的问题：源码被 `Set-Content` 写成乱码、`Get-Content | ConvertFrom-Json` 解析失败、
`-Command` 里的 JSON 引号被 PowerShell 吃掉、中文在控制台显示成 `鏀跨瓥`。根因不是偶发，
而是 PowerShell 的默认编码与参数解析模型。下面是**永久解决办法**，按优先级执行。

## 一、根本原则：不要用 PowerShell 改文件/传 JSON
- **改源码/数据**：用编辑器工具或 `apply_patch`/`edit`，**禁止** `Set-Content`、`Out-File`、`>` 重定向写代码。
- **读写 JSON**：用 `node scripts/json-tool.mjs get|set|keys|count <file> [key...]`
  （Node 始终 UTF-8 无 BOM，不会破坏中文）。
- **传复杂参数**：写成脚本文件再 `node scripts/xxx.mjs`，不要塞进 `-Command` 的字符串里。
- **跑多条命令**：写成 `.mjs`/`.ps1` 文件用 `-File` 执行，避免行内引号地狱。

## 二、一次性配置：PowerShell 7 + UTF-8 profile
以 `pwsh`（PowerShell 7，推荐）为准；Windows PowerShell 5.1 默认 UTF-16/ANSI 更容易坏。

运行一次：
```powershell
pwsh -NoProfile -File scripts/install-pwsh-profile.ps1
```
它会写入 `$PROFILE`（已存在则先备份），内容等价于：
```powershell
$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
$PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'
$PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
```
注意：即使配了 profile，`Set-Content` 仍然会用你**当前进程的**编码重写整文件，所以第一条原则依然优先。

## 三、环境变量（Python/Node 侧）
- Python：`PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`（本仓库 `scripts/*.py` 已自带）。
- 需要指定解释器时用 `DSH_PYTHON_BIN`（例如 Anaconda 的 `python.exe`），不要依赖 PATH。

## 四、验证
```powershell
pwsh -NoProfile -Command "node scripts/json-tool.mjs keys data/portfolio.json"
```
输出应为正常中文/JSON key 列表；若乱码说明控制台代码页仍非 UTF-8，执行 `chcp 65001`。

## 五、为什么这样能“彻底”解决
| 旧做法 | 问题 | 新做法 |
| --- | --- | --- |
| `Set-Content src/x.ts $text` | 用 ANSI/UTF-16 重编码，中文与引号被破坏 | 编辑器工具/`edit`，或 `node` 写文件 |
| `-Command "...'{`"a`":1}'..."` | PowerShell 解析引号、变量展开 | 脚本文件 + `node`/`-File` |
| `Get-Content x.json \| ConvertFrom-Json` | 读入按当前代码页解码，UTF-8 中文坏 | `node scripts/json-tool.mjs` |
| PowerShell 5.1 默认 | 编码不统一 | 装 PowerShell 7 + profile 固定 UTF-8 |

## 六、可选加固
- 统一用 `npm run` 别名（`test:*`、`build`）而不是手敲长命令。
- 需要跨 shell 时用 Git Bash/WSL 执行 `node`/`python`，同样避免 PowerShell 编码层。
- 任何会覆盖文件的自动化脚本，先 `git diff` 检查再提交（本仓库工作流要求）。
