# DSH 无限量日卡面板

> 在 DeepSeek Harness 左侧栏管理中转站「日卡」：粘贴发货信息即可写入模型配置，并实时查看用量、到期倒计时与费用对比。

![category](https://img.shields.io/badge/category-usage%20%26%20model-4a7dff)

---

## 这个插件解决什么问题

中转站（New API / One API 那类）卖的「日卡 24 小时不限量」，发货时给你一段文本：模型名、接口地址、密钥、用量查询链接。

DSH 里手动配置要改两个文件、还要算清楚 `apiKeyEnv` 和 `contextWindow`，很容易漏。这个插件把它变成一次粘贴：

- **粘贴发货信息 → 自动写模型路由 + 存密钥**
- **自动问平台要真实模型列表**（不同平台模型名写法不同，抄错就一直 404）
- **实时看用量和到期**，没有用量接口的平台用本地统计兜底
- **一键修复「已达到输出 token 上限」**

---

## 功能

### 导入

- 粘贴即可，**不要求固定格式**。下列写法都能认：

  ```
  模型 ID：DeepSeek-V4.1-Flash-Day
  基础 URL（首选 HTTP）：http://host:60015/v1
  密钥：sk-xxxx
  用量查询：http://host:60014/usage？key=sk-…
  ```

  - 标签带空格 / 全角冒号 / 中英文混写都行（`模型 ID`、`模型id`、`Model ID`）
  - 全角 `？` `：` `＝` `＆` 会自动转半角
  - `key=sk-…` 这种占位符会被识别并剥离，自动换成真实密钥
  - 没有用量链接也能导入，按端口约定推断

- 导入后**自动请求平台的 `/v1/models`**，用平台返回的真实模型名覆盖粘贴里的写法，并带上平台声明的图片输入 / 推理档位能力。

- 密钥写入 **DSH 凭据服务**，配置文件里只有引用名，不含明文。

### 到期时间

三种来源，优先级从高到低：

| 来源 | 说明 |
|---|---|
| 手动指定 | 面板里填一个具体时间 |
| 平台提供 | 平台用量页有「到期时间」时直接用它 |
| **首次调用起算** | 平台什么都不给时，从**第一次通过 DSH 调用**该模型开始算 N 小时（默认 24） |

侧边栏图标旁有实时倒计时，剩 2 小时转琥珀色、剩 30 分钟转红色。

### 本地用量统计

订阅 DSH 的会话事件，按**真实 token** 记账，按小时分桶。**不需要平台提供任何接口**。

- 近 24 小时 / 今天 / 全部 三个窗口
- 每小时柱状图，悬停看该小时的 token、次数、费用
- 按卡分开统计，不会把多张卡混在一起

### 费用对比

- 按 **DeepSeek 官方峰谷价**折算（Flash 谷价 输入 ¥1 / 缓存 ¥0.02 / 输出 ¥4 每百万 token；峰时翻倍；周末全天谷价）
- 填上你的**卡价**，自动算出省 / 贵多少

### 上下文窗口一键修复

如果你看到 **「已达到输出 token 上限」而且发「继续」也没用**，是上下文窗口没配：

> DSH 会用 `contextWindow - 已用` 算本轮还能输出多少。路由没有显式窗口时回落到 262144，对话超过 26 万后这个差值变成负数，被夹到最小 **1**，于是向中转站发 `max_tokens=1`，中转站正常回「到上限了」。

面板里的「上下文窗口」卡片会诊断每条路由，点**一键修复**写 provider 级的 `defaultContextWindow: 1000000` / `defaultMaxTokens: 64000`。

> 改完需要**完全退出 DSH**（托盘图标右键退出，不是只关窗口）再打开，配置才会重新加载。

---

## 安装

### 桌面版（Electron 客户端）

桌面版**没有 `dsh` 命令行**，请用界面安装：

1. 打开 DSH → 左侧栏「**插件**」
2. 进入插件市场，搜索 `dsh-card-panel`
3. 点安装，按提示重启

### 网页版 / CLI 用户

```bash
dsh plugin --profile web add dsh-card-panel
```

从 GitHub 直接装：

```bash
dsh plugin --profile desktop add github:fengpei666/dsh-card-panel
```

本地开发（软链，改代码立即生效）：

```bash
dsh plugin --profile desktop add link:/path/to/dsh-card-panel
```

---

## 使用

1. 左侧栏点「**无限量日卡**」
2. 把卖家的发货文本整段粘进输入框 → 点「解析并写入配置」
3. 出现卡片后点「**同步平台模型**」确认模型名（导入时其实已自动同步过）
4. 在 DSH 的模型选择器里选这张卡的模型即可对话

切到哪张卡，侧边栏倒计时和输入框上方的统计条就跟着那张卡走，选择会被保存。

---

## 数据存放位置

| 文件 | 内容 |
|---|---|
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | 模型路由配置（导入时写入） |
| `~/.dsh/.credentials.yaml` | API 密钥（由 DSH 凭据服务管理） |
| `~/.dsh/.dsh-card-panel.json` | 各卡用量地址、当前选中的卡 |
| `~/.dsh/.dsh-card-panel-usage.json` | 本地用量账本（按小时） |

删掉后两个文件即可清空本插件的本地状态，不影响模型配置。

---

## 安全说明

插件的 HTTP 路由默认只接受**本机回环地址**的请求，并拒绝跨站请求：

- Host 必须是 `127.0.0.1` / `localhost` / `::1`
- 带 `Sec-Fetch-Site: cross-site` 一律拒绝
- 带 `Origin` 时必须与 Host 同源
- 存在 DSH 自身的连接守卫时，一并委托它校验

需要从别的机器管理时，用环境变量显式授权：

```bash
DSH_CARD_TRUSTED_HOSTS=192.168.1.10:3080 dsh web
```

---

## 已知限制

- **侧边栏倒计时依赖 DOM 注入**：DSH 标签结构变化时可能失效，失效时只是不显示倒计时，不影响其他功能。
- 用量页解析按标签名匹配，平台改版后可能需要调整。
- 官方价格表写在 `lib/index.js` 的 `OFFICIAL_PRICE_CNY`，价格变动时自行修改。

---

## English

**DSH Day-Card Panel** — manage relay "day cards" from the DSH sidebar.

Paste a seller's delivery message and the plugin writes the model route + stores the API key, then shows live usage, an expiry countdown, and a cost comparison against DeepSeek's official list price.

Highlights:

- Tolerant paste parser (label spacing, full-width punctuation, placeholder keys)
- Pulls the gateway's real `/v1/models` so model ids are always correct
- Expiry from manual entry, the vendor, or **first-call + N hours**
- Local token accounting per card, hourly buckets, no vendor API needed
- One-click fix for the "hit the output token limit" trap caused by a missing `defaultContextWindow`
- Request fence: loopback-only, cross-site rejected

Install (desktop): DSH sidebar → **Plugins** → search `dsh-card-panel` → Install.

Install (CLI): `dsh plugin --profile web add dsh-card-panel`

---

## License

MIT
