---
title: "REPO 怪物透视实现：从找骨骼到 GL 绘制 ESP 方框"
date: "2026-09-12"
updated: "2026-09-12T16:00:00.000Z"
category: "game-hacking"
tags: ["REPO", "Unity", "Mono", "BepInEx", "ESP", "逆向工程", "游戏注入"]
---

# REPO 怪物透视实现：从找骨骼到 GL 绘制 ESP 方框

![REPO 怪物透视封面](/img/game-hacking/repo-esp/cover.png)

> 目标：给《R.E.P.O.》（Unity 2022.3，Mono 后端，Photon 联机）写一个 BepInEx 插件，实时给怪物画 2D 方框 + 骨骼点线（ESP）。
> 核心挑战：REPO 的怪不是 Unity 人形骨骼，没有 `SkinnedMeshRenderer.m_Bones`；插件组件挂在 BepInEx 管理器对象上会被销毁；怪物身上挂着一堆粒子渲染器会把包围框撑爆。

代码仓库：[BitterG/Repo-Esp-Plugin](https://github.com/BitterG/Repo-Esp-Plugin)

---

## 一、确认游戏引擎与运行时

逆向第一步永远是先确认"目标是什么"。直接看游戏安装目录：

- 根目录只有 `REPO.exe`、`UnityPlayer.dll`，**没有** `GameAssembly.dll`
- `REPO_Data` 下有 `Managed\Assembly-CSharp.dll`，**没有** `il2cpp_data`

结论：**Unity 2022.3 + Mono 后端**。这直接决定工具选型——用 dnSpy 反编译 `Assembly-CSharp.dll`，不需要 Il2CppDumper。

![游戏目录确认 Mono 后端](/img/game-hacking/repo-esp/engine-mono.png)

## 二、准备工具

| 工具 | 用途 |
|---|---|
| [dnSpyEx](https://github.com/dnSpyEx/dnSpy) | 反编译 `Assembly-CSharp.dll`，看怪物类结构 |
| BepInEx 5.4.23.5 | 注入框架，Thunderstore 上 R.E.P.O. 的 `BepInExPack` |
| UnityExplorer 4.9.0 | 游戏内对象浏览器，运行时观察怪物层级（BepInEx5.Mono 版） |
| Visual Studio 2022 / dotnet SDK | 编译 C# 插件（net472） |

插件工程只需引用游戏目录下的 `BepInEx\core\BepInEx.dll` 和 `REPO_Data\Managed\` 里的 `UnityEngine.dll`、`UnityEngine.CoreModule.dll`、`UnityEngine.IMGUIModule.dll` 等。

## 三、在游戏里找到怪物和骨骼

### 3.1 鼠标取点：Inspector → Mouse Inspect → World

UnityExplorer 4.9.0 的取点入口不在顶部菜单栏，而在 **Inspector 面板内部**：

1. 游戏内按 `F7` 打开 UnityExplorer
2. 打开 `Inspector` 面板，找到 `Mouse Inspect` 下拉框，选 `World`
3. 鼠标对准怪物单击，怪物的 GameObject 就会加载进 Inspector

在 Inspector 的组件列表里能看到怪物的根节点挂的是逻辑组件：`Transform` / `EnemyParent` / `EnemyChecklist` / `Photon.Pun.PhotonView`。注意**渲染器不在这里**，全在子物体上。

![UnityExplorer Mouse Inspect 取点](/img/game-hacking/repo-esp/unityexplorer-mouse-inspect.png)

### 3.2 骨骼在哪里

点开怪物的子层级后会发现一个关键事实：REPO 的怪用的**不是** Unity 人形骨骼（没有 `SkinnedMeshRenderer`），它的 mesh 是普通 `MeshRenderer`（静态网格），所以根本没有 `m_Bones` 数组。

它的"骨骼"其实就是名字以 `ANIM` 开头的一串 Transform 节点，游戏脚本直接旋转/移动这些节点来做动画：

```
EnemyXxx(Clone)
└─ [VISUALS]
   ├─ ANIM BOT            ← 下半身
   ├─ ANIM MID            ← 躯干
   │    └─ mesh body      ← 身体网格（MeshRenderer）
   ├─ ANIM ARM LEFT ─ mesh arm
   ├─ ANIM ARM RIGHT ─ mesh arm
   └─ ANIM HEAD ─ mesh head
```

![怪物的骨骼层级](/img/game-hacking/repo-esp/skeleton-hierarchy.png)

### 3.3 静态分析确认类名

用 dnSpy 反编译 `Assembly-CSharp.dll`，搜索 `Enemy` 可以看到所有怪物类都遵循 `Enemy*` 命名：基类 `EnemyParent`，以及 `EnemyRobe`、`EnemyGnome`、`EnemyHunter`、`EnemyHead`、`EnemyCeilingEye` 等。

![dnSpy 中的 Enemy* 类](/img/game-hacking/repo-esp/dnspy-enemy-classes.png)

因此运行时也可以在 UnityExplorer 的 `Object Explorer` 里直接搜 `Enemy`，列出当前场景里所有已刷出的怪物实例。

![Object Explorer 搜索 Enemy](/img/game-hacking/repo-esp/object-explorer-search-enemy.png)

## 四、代码实现（BepInEx 插件）

插件结构很简单：一个 `[BepInPlugin]` 入口 + 一个 `MonoBehaviour` 组件，全部逻辑都是 static 的（原因见踩坑记录）。

### 4.1 怪物遍历

启动时反射找到 `EnemyParent` 类型，每帧用 `Resources.FindObjectsOfTypeAll` 枚举所有实例，过滤掉资源对象和未激活对象：

```csharp
static Type FindTypeByName(string name)
{
    foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        foreach (var t in asm.GetTypes())
            if (t.Name == name) return t;
    return null;
}

static IEnumerable<GameObject> GetEnemies()
{
    foreach (var o in Resources.FindObjectsOfTypeAll(enemyType))
    {
        var c = o as Component;
        if (c == null) continue;
        var g = c.gameObject;
        if (g == null || !g.scene.IsValid() || !g.activeInHierarchy) continue;
        yield return g;
    }
    // 兜底：按 GameObject 名字 Enemy* 找
}
```

- `FindObjectsOfTypeAll`：返回**所有已加载**实例（含未激活、含派生类），比 `FindObjectsOfType` 更全
- `scene.IsValid()`：排除 prefab 资源，只留场景实例
- `activeInHierarchy`：排除已 despawn 的怪

### 4.2 骨骼遍历

"找骨骼" = 递归遍历怪物的 Transform 子树，收集名字以 `ANIM` 开头的节点；若不足 2 个，则退回把 `VISUALS` 节点的整棵子树当骨骼：

```csharp
static void CollectByPrefix(Transform t, string prefix, List<Transform> outList)
{
    if (t.name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        outList.Add(t);
    for (int i = 0; i < t.childCount; i++)
        CollectByPrefix(t.GetChild(i), prefix, outList);
}
```

骨骼的世界坐标直接取 `bone.position`（Unity 自动完成局部→世界转换）。

### 4.3 投影与 GL 绘制

**为什么不挂在 `Update`/`OnGUI` 上**：实测插件的 `Awake`、`OnEnable` 都执行了，但 `Start`、`Update`、`OnGUI` 全部不执行——因为组件挂在 BepInEx 的 `BepInEx_Manager` 对象上，游戏切场景时这个对象被销毁。所以改为订阅 `Camera.onPostRender`，回调挂在 **static 方法**上，即使组件被销毁，渲染回调依然每帧触发：

```csharp
Camera.onPostRender += OnPostRenderCallback;

static void OnPostRenderCallback(Camera cam)
{
    lineMat.SetPass(0);          // Hidden/Internal-Colored shader，让 GL.Color 生效
    GL.PushMatrix();
    GL.LoadPixelMatrix();        // 2D 像素坐标系（原点左下，y 向上）
    // ... 画框、画骨骼 ...
    GL.PopMatrix();
}
```

投影用 Unity 自带的 `WorldToScreenPoint`：

```csharp
Vector3 sp = cam.WorldToScreenPoint(worldPos);
// sp.x / sp.y = 屏幕像素坐标（y 从下往上，与 GL.LoadPixelMatrix 一致，不用翻转）
// sp.z < 0 表示该点在相机背后，必须跳过
```

**骨骼连线**：对每个骨骼节点，找"最近的、也在骨骼集合里的祖先"，父子都投影后画一条黄线；骨节点本身用 `GL.QUADS` 画小方块：

```csharp
var p = n.parent;
while (p != null && !set.Contains(p)) p = p.parent;  // 跳过中间非骨骼节点
if (p != null)
{
    Vector3 pp = cam.WorldToScreenPoint(p.position);
    if (pp.z >= 0)
    {
        GL.Begin(GL.LINES);
        GL.Color(Color.yellow);
        GL.Vertex(new Vector3(sp.x, sp.y, 0));
        GL.Vertex(new Vector3(pp.x, pp.y, 0));
        GL.End();
    }
}
```

**方框**：合并怪物所有 `MeshRenderer` / `SkinnedMeshRenderer` 的 `bounds`（**必须排除粒子/拖尾渲染器**，否则框会被撑得巨大），取 8 个角投影，取屏幕 x/y 的 min/max 画 2D 矩形。有任意角在镜头后则整框跳过，避免乱线：

```csharp
float minX = float.MaxValue, minY = float.MaxValue;
float maxX = float.MinValue, maxY = float.MinValue;

foreach (var p in corners)
{
    Vector3 sp = cam.WorldToScreenPoint(p);
    if (sp.z < 0) return;            // 镜头后，跳过整个框
    if (sp.x < minX) minX = sp.x;
    if (sp.x > maxX) maxX = sp.x;
    if (sp.y < minY) minY = sp.y;
    if (sp.y > maxY) maxY = sp.y;
}
// 用 (minX,minY)-(maxX,maxY) 画 4 条线
```

### 4.4 每帧完整流程

```
Camera.onPostRender 触发
  ├─ 枚举所有 EnemyParent 实例（找怪）
  ├─ 对每只怪：
  │    ├─ GetComponentsInChildren<Renderer>() → 只取 Mesh/SkinnedMesh 的 bounds
  │    │    → 合并 → 8 角投影 → 画 2D 方框
  │    └─ CollectByPrefix(transform, "ANIM") → 收集骨骼 Transform
  │         → 逐个投影 → 画黄点 + 父子连线
  └─ 画左上/右上角指示灯
```

## 五、踩坑记录

1. **组件挂在 `BepInEx_Manager` 上，`OnEnable` 之后 `Start`/`Update` 都不执行**：游戏切场景时管理器对象被销毁。解法：`Camera.onPostRender` + static 回调，不依赖自身组件存活。
2. **方框巨大且错误**：日志显示一只怪有 43 个 Renderer——包含大量粒子/拖尾渲染器，全部合并 bounds 会把框撑成巨型长方体。解法：只合并 `MeshRenderer` / `SkinnedMeshRenderer`。
3. **镜头后方的点画出乱线**：`WorldToScreenPoint` 对相机背后的点会返回错误坐标。解法：`sp.z < 0` 直接剔除（骨骼逐点剔除，方框整框跳过）。
4. **首局没骨骼线，重开一局才有**：第一局怪还没真正刷出来（`enemies=4 renderers=0`），重开后正常（`renderers=43`）。属正常现象，不是 bug。

## 六、总结

整条链路可以概括为三步：

1. **动态观察**：UnityExplorer 点怪、展开层级，确认 `EnemyParent` 组件和 `ANIM ...` 骨骼命名规律
2. **静态分析**：dnSpy 反编译 `Assembly-CSharp.dll`，确认 `Enemy*` 类名体系
3. **自动化**：把观察到的规律写成 BepInEx 插件——`FindObjectsOfTypeAll(EnemyParent)` 找怪 → `CollectByPrefix("ANIM")` 找骨骼 → `WorldToScreenPoint` 投影 → `onPostRender` + GL 画线

最终效果：每只怪物一个绿色 2D 方框 + 黄色骨骼点线，`F6` 开关显示，左上/右上角小方块作为插件存活指示。

> 本文仅用于逆向学习，请只在私人房间测试，勿在公共对局影响他人。
