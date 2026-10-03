# 顺路 · 旅行路线

把想去的地方排成最顺的路线。每次打开都会按**现在的位置、现在的时间、营业时间**重新计算。
全部使用免费服务：不用申请 API key，不用绑信用卡，也不用开着电脑。

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 页面 |
| `css/style.css` | 样式 |
| `js/app.js` | 主程序：地图、列表、设置、自动重算 |
| `js/optimizer.js` | 排顺序的算法（在手机里运行，免费） |
| `js/geo.js` | 搜索地点、查交通时间、画路线（免费服务器） |
| `js/hours.js` | 读营业时间 |
| `js/discover.js` | 城市、热门景点、照片和介绍（Wikidata / 维基百科）、槟城示例 |
| `js/days.js` | 多天行程：把地点分到每一天 |
| `js/icons.js` | 界面用的线条图标 |

> 改了 css / js 之后，把 `index.html` 和 `js/app.js` 里的 `?v=7` 都加一（例如 `?v=8`），手机才会马上拿到新版。
| `sw.js`、`manifest.webmanifest`、`icons/` | 让它可以"安装"到手机主屏幕 |

## 放上网（免费，大约 10 分钟，只需要做一次）

用 **GitHub Pages**，不需要信用卡：

1. 去 <https://github.com> 注册一个免费账号
2. 右上角 **+** → **New repository**
   - Repository name：`shunlu`（或其他英文名字）
   - 选 **Public**
   - 按 **Create repository**
3. 在新页面点 **uploading an existing file**
4. 打开电脑的 `D:\Travel` 文件夹，把下面这些**全部拖进去**：
   `index.html`、`manifest.webmanifest`、`sw.js`、`README.md`，以及 `css`、`js`、`icons` 三个文件夹
   （`.claude` 文件夹不用传）
5. 按页面最下面的 **Commit changes**
6. 进入这个 repository 的 **Settings** → 左边点 **Pages**
   - Source 选 **Deploy from a branch**
   - Branch 选 **main**，文件夹选 **/ (root)**，按 **Save**
7. 等 1~2 分钟，刷新这个页面，上方会显示网址：
   `https://你的用户名.github.io/shunlu/`

之后电脑关掉也能用。

## 装到手机

- **iPhone**：用 **Safari** 打开网址 → 下面的分享按钮 → **添加到主屏幕**
- **Android**：用 **Chrome** 打开网址 → 右上角 ⋮ → **安装应用** 或 **添加到主屏幕**

第一次打开时会询问定位权限，请选**允许**。

## 以后要更新

修改文件后，回到 GitHub 的 repository 页面 → **Add file → Upload files**，把改过的文件拖进去覆盖 → **Commit changes**。
手机下次打开就会自动换成新版本。

## 注意

- 行程数据**只存在你的手机里**，不会上传。换手机或清除浏览器数据前，请先在「设置 → 导出行程」备份
- repository 是 Public，别人看得到**代码**，但看不到你的行程
- 免费服务器**没有实时塞车资料**。不过每次打开都会从你现在的位置和时间重新算，所以已经耽误的时间会自动反映出来
- 营业时间来自 OpenStreetMap，不一定完整，可以在每个地点里手动修改
- 用到的免费服务：地图 OpenFreeMap / OpenStreetMap，搜索 Nominatim，开车路线 OSRM，走路路线 Valhalla（FOSSGIS）
