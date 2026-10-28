// ===== VOXEL DIORAMA ENGINE for Deepdreamlings =====
// Renders tile maps as 3D voxel dioramas using Three.js.
// Game logic (movement, encounters, etc.) is unchanged — only rendering is 3D.

const VoxelEngine = (function() {
  let renderer, scene, camera, dirLight, hemiLight;
  let tileMeshes = {};      // tileIndex -> InstancedMesh
  let tileTextures = {};    // tileName -> THREE.Texture
  let worldGroup = null;
  let baseMesh = null;
  let charSprite = null;
  let charTextures = {};
  let companionSprite = null;
  let floaterSprites = [];
  let genGroup = null;
  let waterSlotBodyMat = null;
  // Encounter cabinet machine (3D, camera-facing) + dreamling image cache
  let encMachine = null;
  const _camDir = new THREE.Vector3();
  let woodsSlotTiles = []; // [{c,r}] green machine tiles in Waking Woods (encounter triggers)
  const dreamImgCache = {};
  function dreamImg(n, cb) {
    if (dreamImgCache[n]) {
      if (dreamImgCache[n].complete && dreamImgCache[n].naturalWidth) cb(dreamImgCache[n]);
      else dreamImgCache[n].addEventListener('load', function() { cb(dreamImgCache[n]); });
      return;
    }
    const im = new Image();
    dreamImgCache[n] = im;
    im.onload = function() { cb(im); };
    im.src = 'dreamlingP' + n + '.png';
  }
  function disposeGroup(g) {
    g.traverse(function(o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(function(mt) { if (mt.map) mt.map.dispose(); mt.dispose(); });
      }
    });
  }
  let initialized = false;
  let mapData = null;
  let tileSize3D = 1;

  // Diorama aesthetic
  const DIORAMA = {
    groundHeight: 0.35,
    solidHeight: 1.0,
    treeTrunkHeight: 1.0,
    treeCanopyHeight: 1.4,
    treeCanopyWidth: 1.5,
    waterHeight: 0.22,
    pathHeight: 0.12,          // dirt paths sit sunken into the ground
    baseColor: 0x5a3a28,      // wooden diorama base
    baseHeight: 0.8,
  };

  function init(canvas) {
    if (initialized) return;
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0512);
    scene.fog = new THREE.Fog(0x0a0512, 30, 80);  // soft depth fade for diorama feel

    // Diorama camera: angled top-down, like looking at a physical model
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);

    // Soft studio lighting for the diorama
    hemiLight = new THREE.HemisphereLight(0xc9b8ff, 0x2a1a3a, 0.75);
    scene.add(hemiLight);
    dirLight = new THREE.DirectionalLight(0xfff2dd, 0.85);
    dirLight.position.set(18, 28, 12);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.left = -30;
    dirLight.shadow.camera.right = 30;
    dirLight.shadow.camera.top = 30;
    dirLight.shadow.camera.bottom = -30;
    dirLight.shadow.camera.far = 80;
    scene.add(dirLight);

    // Subtle rim light for depth
    const rim = new THREE.DirectionalLight(0x8affea, 0.25);
    rim.position.set(-15, 10, -20);
    scene.add(rim);

    worldGroup = new THREE.Group();
    scene.add(worldGroup);

    initialized = true;
    resize();
  }

  function resize() {
    if (!renderer) return;
    const w = renderer.domElement.clientWidth || window.innerWidth;
    const h = renderer.domElement.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // Load a tile texture (cached). Uses embedded data URIs when available (file:// testing).
  function resolveUrl(name) {
    if (!name) return name;
    var base = ("" + name).split("/").pop();
    if (typeof TILE_DATA_URIS !== "undefined" && TILE_DATA_URIS[base]) return TILE_DATA_URIS[base];
    if (typeof TILE_DATA_URIS !== "undefined" && TILE_DATA_URIS[name]) return TILE_DATA_URIS[name];
    return name;
  }
  function getTileTexture(name) {
    if (tileTextures[name]) return tileTextures[name];
    const tex = new THREE.TextureLoader().load(resolveUrl(name), function() {
      tex.needsUpdate = true;
    });
    tex.magFilter = THREE.NearestFilter;  // pixel-art crispness
    tex.minFilter = THREE.NearestFilter;
    tex.encoding = THREE.sRGBEncoding;
    tileTextures[name] = tex;
    return tex;
  }

  // Procedural mottled grass texture — consistent green, no stripes, no variants.
  let procGrassTex = null;
  function getProceduralGrass() {
    if (procGrassTex) return procGrassTex;
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const x = c.getContext("2d");
    x.fillStyle = "#5aa84a"; x.fillRect(0, 0, 64, 64);
    // mottled darker/lighter patches
    for (let i = 0; i < 380; i++) {
      const g = 140 + Math.floor(Math.random() * 60);
      x.fillStyle = "rgb(" + (g - 40) + "," + g + "," + (g - 50) + ")";
      x.fillRect(Math.floor(Math.random() * 64), Math.floor(Math.random() * 64), 2, 2);
    }
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
    t.encoding = THREE.sRGBEncoding;
    procGrassTex = t;
    return t;
  }

  // Dirt tiles: tree7/tree8 are dirt-textured (misnamed "tree") — the dirt path.
  // They sit sunken into the ground, never as pines.
  function isDirtTile(name) {
    const n = (name || "").toLowerCase();
    return /dirt/.test(n) || /tree7|tree8/.test(n);
  }

  // Determine voxel height by tile type
  function tileHeight(tileName, isSolid) {
    const n = (tileName || "").toLowerCase();
    if (/water/i.test(n)) return DIORAMA.waterHeight;
    if (isDirtTile(n)) return 0.1;   // sunken dirt path
    if (/path|road/i.test(n)) return DIORAMA.pathHeight;
    if (/grass/i.test(n)) return DIORAMA.groundHeight;  // grass is always flat ground, even if solid
    if (/tree/i.test(n)) return -1;  // trees get custom stacked geometry (see buildWorld)
    // Only structural tiles (doors, roofs, walls) stand tall. Everything else solid
    // (vegetation, props, misc) renders flat — no more stray tall green boxes.
    if (isSolid) {
      if (/door|roof|wall|building|house/i.test(n)) return DIORAMA.solidHeight;
      return DIORAMA.groundHeight;
    }
    return DIORAMA.groundHeight;
  }

  // Check if tile is a tree/prop (gets stacked trunk+canopy, stood up in 3D).
  // tree7/tree8 are dirt, not foliage — excluded.
  function isTreeTile(name) {
    if (isDirtTile(name)) return false;
    if (/tree|bush|plant|shrub|foliage|leaf|leaves|palm|pine|oak/i.test(name || "")) return true;
    return false;
  }

  // Structural fallback: a solid tile with no solid orthogonal neighbors is a
  // standalone prop (tree, rock, statue) — stand it up even if the name is unknown.
  function isIsolatedSolid(M, c, r) {
    if (!M.solid || !M.solid[r] || !M.solid[r][c]) return false;
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dc, dr] of dirs) {
      const nc = c + dc, nr = r + dr;
      if (nc >= 0 && nr >= 0 && nc < M.cols && nr < M.rows &&
          M.solid[nr] && M.solid[nr][nc]) return false;
    }
    return true;
  }

  // Check if tile is water (for material)
  function isWaterTile(name) {
    return /water/i.test(name || "");
  }

  // Build the voxel world from map JSON
  function buildWorld(M, mapName) {
    // mapName: "map" for Dream Core, used for Dream-Core-only fixes (procedural grass)
    mapData = M;
    // Clear old world
    while (worldGroup.children.length > 0) {
      const c = worldGroup.children[0];
      worldGroup.remove(c);
      if (c.geometry) c.geometry.dispose();
    }
    tileMeshes = {};
    woodsSlotTiles = [];
    if (encMachine) encMachine.visible = false;
    floaterSprites = [];

    const cols = M.cols, rows = M.rows;
    const tiles = M.tiles || [];

    // Group tile positions by texture for instancing
    const byTile = {};
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = M.map[r][c];
        if (idx < 0 || idx >= tiles.length) continue;
        const name = tiles[idx];
        if (!byTile[name]) byTile[name] = [];
        const solid = M.solid && M.solid[r] && M.solid[r][c];
        byTile[name].push({ c: c, r: r, solid: !!solid });
      }
    }

    // Create instanced voxel meshes per tile type
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);

    // Collect tree/prop positions for stacked trunk+canopy (stood up in 3D)
    const treePositions = [];

    for (const name in byTile) {
      const list = byTile[name];
      const namedTree = isTreeTile(name);
      const namedDirt = isDirtTile(name);
      const treeList = [], flatList = [];
      for (const t of list) {
        // Only explicitly-named foliage trees become pines. Dirt never becomes a tree.
        if (!namedDirt && namedTree) treeList.push(t);
        else flatList.push(t);
      }
      for (const t of treeList) treePositions.push({ c: t.c, r: t.r, texName: name });
      if (!flatList.length) continue;
      // Procedural grass ONLY for Dream Core's ground tiles (fixes the striped tile).
      // Other areas (Woods, Meadow, Sky, Grove) keep their own textures — zentangle art etc.
      let tex;
      const ln = name.toLowerCase();
      const isDreamCore = (mapName === "map");
      if (isDreamCore && !/water|dirt|path|road|door|roof/i.test(ln)) {
        tex = getProceduralGrass();
      } else {
        tex = getTileTexture(name);
      }
      const isWater = isWaterTile(name);

      // Material: textured top, slightly darker sides for voxel depth
      const mat = new THREE.MeshLambertMaterial({
        map: tex,
        transparent: isWater,
        opacity: isWater ? 0.85 : 1.0,
      });

      const im = new THREE.InstancedMesh(boxGeo, mat, flatList.length);
      im.castShadow = !isWater;
      im.receiveShadow = true;

      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();

      for (let i = 0; i < flatList.length; i++) {
        const t = flatList[i];
        const h = tileHeight(name, t.solid);
        // x = col, z = row, y = height/2 (sitting on base)
        pos.set(t.c, h / 2, t.r);
        scl.set(1, h, 1);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
        m4.compose(pos, q, scl);
        im.setMatrixAt(i, m4);
      }
      im.instanceMatrix.needsUpdate = true;
      worldGroup.add(im);
      tileMeshes[name] = im;
    }

    // 3D TREES: proper voxel pine shape — brown trunk + 3 stacked canopy layers.
    // Grouped by texture so mixed tree types keep their own look.
    if (treePositions.length > 0) {
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
      // Trunk: single brown instanced mesh for all trees
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
      const trunkIM = new THREE.InstancedMesh(boxGeo, trunkMat, treePositions.length);
      trunkIM.castShadow = true; trunkIM.receiveShadow = true;
      const TRUNK_H = 1.8, TRUNK_W = 0.5;
      for (let i = 0; i < treePositions.length; i++) {
        const t = treePositions[i];
        pos.set(t.c, TRUNK_H / 2, t.r); scl.set(TRUNK_W, TRUNK_H, TRUNK_W);
        m4.compose(pos, q, scl); trunkIM.setMatrixAt(i, m4);
      }
      trunkIM.instanceMatrix.needsUpdate = true;
      worldGroup.add(trunkIM);
      // Canopy: 3 shrinking layers per tree, grouped by tile texture.
      // Trunk is tall (1.8) so it's clearly visible from a straight-on front view —
      // canopy starts above it, no more "green slab" look.
      const byTex = {};
      for (const t of treePositions) { (byTex[t.texName] = byTex[t.texName] || []).push(t); }
      // [width, height, yBaseOffset] for each layer, from bottom to top
      const LAYERS = [
        [1.5, 0.7, TRUNK_H - 0.15],
        [1.1, 0.6, TRUNK_H + 0.4],
        [0.7, 0.5, TRUNK_H + 0.85],
      ];
      for (const texName in byTex) {
        const grp = byTex[texName];
        const canopyMat = new THREE.MeshLambertMaterial({ map: getTileTexture(texName) });
        for (let L = 0; L < LAYERS.length; L++) {
          const [lw, lh, ly] = LAYERS[L];
          const im = new THREE.InstancedMesh(boxGeo, canopyMat, grp.length);
          im.castShadow = true; im.receiveShadow = true;
          for (let i = 0; i < grp.length; i++) {
            const t = grp[i];
            pos.set(t.c, ly + lh / 2, t.r); scl.set(lw, lh, lw);
            m4.compose(pos, q, scl); im.setMatrixAt(i, m4);
          }
          im.instanceMatrix.needsUpdate = true;
          worldGroup.add(im);
        }
      }
    }

    // Diorama base: wooden platform under the whole map
    const baseGeo = new THREE.BoxGeometry(cols + 2, DIORAMA.baseHeight, rows + 2);
    const baseMat = new THREE.MeshLambertMaterial({ color: DIORAMA.baseColor });
    baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.set((cols - 1) / 2, -DIORAMA.baseHeight / 2 + 0.01, (rows - 1) / 2);
    baseMesh.receiveShadow = true;
    worldGroup.add(baseMesh);

    // SLOT MACHINE markers on water: 3D slot machines floating on each water region
    // so players know there's something in the water (encounters live here).
    (function addWaterSlots(){
      // Find water tiles and group into contiguous regions via flood fill
      const waterSet = {};
      const waterTiles = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const idx = M.map[r][c];
        if (idx < 0 || idx >= tiles.length) continue;
        if (/water/i.test(tiles[idx] || "")) {
          waterSet[c + "," + r] = true;
          waterTiles.push({ c: c, r: r });
        }
      }
      if (!waterTiles.length) return;
      const visited = {}, regions = [];
      waterTiles.forEach(function(t) {
        const key = t.c + "," + t.r;
        if (visited[key]) return;
        const region = [], stack = [t];
        visited[key] = true;
        while (stack.length) {
          const cur = stack.pop();
          region.push(cur);
          [[1,0],[-1,0],[0,1],[0,-1]].forEach(function(d) {
            const nk = (cur.c + d[0]) + "," + (cur.r + d[1]);
            if (waterSet[nk] && !visited[nk]) { visited[nk] = true; stack.push({ c: cur.c + d[0], r: cur.r + d[1] }); }
          });
        }
        if (region.length >= 4) regions.push(region);  // only sizable water
      });
      // Build a 3D slot machine for each region (at its center tile)
      // DETAILED model: pedestal, body, reel window with symbols, marquee, lever
      const slotGroup = new THREE.Group();
      const bodyMat = new THREE.MeshLambertMaterial({ color: 0x5a1a8a });
      // Store for video skin updates (deepdream overlay)
      waterSlotBodyMat = bodyMat;
      const darkMat = new THREE.MeshLambertMaterial({ color: 0x1a0a2e });
      const goldMat = new THREE.MeshLambertMaterial({ color: 0xd4a017 });
      const reelMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const glowPink = new THREE.MeshBasicMaterial({ color: 0xff4ad8 });
      const glowCyan = new THREE.MeshBasicMaterial({ color: 0x4ad8ff });
      const leverMat = new THREE.MeshLambertMaterial({ color: 0xe0e0e0 });
      regions.forEach(function(region) {
        let sc = 0, sr = 0;
        region.forEach(function(t) { sc += t.c; sr += t.r; });
        sc = Math.round(sc / region.length); sr = Math.round(sr / region.length);
        const machine = new THREE.Group();
        // Pedestal base
        const ped = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.25, 0.9), darkMat);
        ped.position.y = 0.12; ped.castShadow = true; machine.add(ped);
        // Gold trim on pedestal
        const pedTrim = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.06, 0.94), goldMat);
        pedTrim.position.y = 0.27; machine.add(pedTrim);
        // Main body
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.2, 0.7), bodyMat);
        body.position.y = 0.9; body.castShadow = true; machine.add(body);
        // Side panels (darker)
        const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.6), darkMat);
        sideL.position.set(-0.46, 0.9, 0); machine.add(sideL);
        const sideR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.6), darkMat);
        sideR.position.set(0.46, 0.9, 0); machine.add(sideR);
        // Reel window (recessed dark)
        const winFrame = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.5, 0.1), goldMat);
        winFrame.position.set(0, 1.05, 0.32); machine.add(winFrame);
        const winBg = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.42, 0.06), darkMat);
        winBg.position.set(0, 1.05, 0.35); machine.add(winBg);
        // 3 CORRECT spinning reels: vertical cylinders with symbol texture
        // Each reel has 6 symbols (red/green/blue diamonds) around the circumference
        function makeReelTexture() {
          const c = document.createElement('canvas');
          c.width = 192; c.height = 64;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 192, 64);
          const colors = ['#ff4444', '#44ff44', '#4444ff', '#ff44ff', '#ffaa00', '#44ffff'];
          for (let s = 0; s < 6; s++) {
            const cx = s * 32 + 16, cy = 32;
            ctx.fillStyle = colors[s];
            ctx.beginPath();
            ctx.moveTo(cx, cy-12); ctx.lineTo(cx+10, cy); ctx.lineTo(cx, cy+12); ctx.lineTo(cx-10, cy);
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
          }
          const tex = new THREE.CanvasTexture(c);
          tex.wrapS = THREE.RepeatWrapping;
          return tex;
        }
        const reelTex = makeReelTexture();
        machine.userData.reels = [];
        machine.userData.reelSpeeds = [0, 0, 0];
        machine.userData.reelTargets = [0, 0, 0];
        for (let i = -1; i <= 1; i++) {
          const reelGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.22, 16);
          const reelMat2 = new THREE.MeshLambertMaterial({ map: reelTex.clone() });
          reelMat2.map.needsUpdate = true;
          const reel = new THREE.Mesh(reelGeo, reelMat2);
          // Rotate so the cylinder axis is horizontal (facing forward)
          reel.rotation.z = Math.PI / 2;
          reel.rotation.y = Math.PI / 2;
          reel.position.set(i * 0.22, 1.05, 0.39);
          machine.add(reel);
          machine.userData.reels.push(reel);
          // Store initial rotation for spin control
          reel.userData.spinAngle = 0;
          reel.userData.targetAngle = 0;
          reel.userData.spinning = false;
        }
        // Marquee top (glowing)
        const marquee = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.28, 0.74), darkMat);
        marquee.position.y = 1.64; marquee.castShadow = true; machine.add(marquee);
        const marqGlow = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.1, 0.76), glowPink);
        marqGlow.position.y = 1.8; machine.add(marqGlow);
        // "SPIN" lights (small glowing dots)
        for (let li = 0; li < 5; li++) {
          const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8),
            li % 2 ? glowPink : glowCyan);
          bulb.position.set(-0.36 + li * 0.18, 1.64, 0.38); machine.add(bulb);
        }
        // Lever (right side) with pivot
        const leverBase = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 10), darkMat);
        leverBase.position.set(0.5, 1.2, 0); leverBase.rotation.z = Math.PI/2; machine.add(leverBase);
        const leverArm = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.55, 8), leverMat);
        leverArm.position.set(0.58, 1.45, 0); leverArm.rotation.z = -0.35; machine.add(leverArm);
        machine.userData.leverArm = leverArm;
        const leverBall = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), glowPink);
        leverBall.position.set(0.68, 1.7, 0); machine.add(leverBall);
        machine.userData.leverBall = leverBall;
        // Coin tray at bottom front
        const tray = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.2), darkMat);
        tray.position.set(0, 0.38, 0.4); machine.add(tray);
        // Position on water
        machine.position.set(sc + 0.5, DIORAMA.waterHeight + 0.1, sr + 0.5);
        machine.userData.isWaterSlot = true;
        machine.userData.baseY = DIORAMA.waterHeight + 0.1;
        machine.userData.phase = Math.random() * 6.28;
        slotGroup.add(machine);
      });
      worldGroup.add(slotGroup);
      // Store for animation
      if (!worldGroup.userData.waterSlots) worldGroup.userData.waterSlots = [];
      slotGroup.children.forEach(function(m) { worldGroup.userData.waterSlots.push(m); });
    })();

    // GREEN slot machines in Waking Woods: 3 machines at random walkable spots.
    (function addWoodsSlots(){
      if (mapName !== "woods") return;
      const banned = [];
      (M.warps || []).forEach(function(w) { banned.push([w.x, w.y]); });
      banned.push([2, 25]); // woods spawn
      const genR = { x: 5, y: 22, w: 3, h: 2 }; // woods generator hut
      function bannedCell(c, r) {
        for (let i = 0; i < banned.length; i++) {
          if (Math.max(Math.abs(c - banned[i][0]), Math.abs(r - banned[i][1])) < 3) return true;
        }
        if (c >= genR.x - 2 && c < genR.x + genR.w + 2 && r >= genR.y - 2 && r < genR.y + genR.h + 2) return true;
        return false;
      }
      const spots = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const idx = M.map[r][c];
        if (idx < 0 || idx >= tiles.length) continue;
        const nm = (tiles[idx] || "").toLowerCase();
        if (/water|tree/i.test(nm)) continue;
        if (M.solid && M.solid[r] && M.solid[r][c]) continue;
        if (bannedCell(c, r)) continue;
        spots.push({ c: c, r: r });
      }
      if (spots.length < 3) return;
      const picked = [];
      let guard = 0;
      while (picked.length < 3 && guard++ < 500) {
        const t = spots[Math.floor(Math.random() * spots.length)];
        if (picked.every(function(p) { return Math.max(Math.abs(p.c - t.c), Math.abs(p.r - t.r)) >= 12; })) picked.push(t);
      }
      if (picked.length < 3) return;
      woodsSlotTiles = picked.map(function(t) { return { c: t.c, r: t.r }; });
      const greenMat = new THREE.MeshLambertMaterial({ color: 0x1a8a3a });
      const darkMat = new THREE.MeshLambertMaterial({ color: 0x1a0a2e });
      const goldMat = new THREE.MeshLambertMaterial({ color: 0xd4a017 });
      const glowPink = new THREE.MeshBasicMaterial({ color: 0xff4ad8 });
      const glowCyan = new THREE.MeshBasicMaterial({ color: 0x4ad8ff });
      const leverMat = new THREE.MeshLambertMaterial({ color: 0xe0e0e0 });
      function makeReelTexture() {
        const c = document.createElement('canvas');
        c.width = 192; c.height = 64;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 192, 64);
        const colors = ['#ff4444', '#44ff44', '#4444ff', '#ff44ff', '#ffaa00', '#44ffff'];
        for (let s = 0; s < 6; s++) {
          const cx = s * 32 + 16, cy = 32;
          ctx.fillStyle = colors[s];
          ctx.beginPath();
          ctx.moveTo(cx, cy-12); ctx.lineTo(cx+10, cy); ctx.lineTo(cx, cy+12); ctx.lineTo(cx-10, cy);
          ctx.closePath(); ctx.fill();
          ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
        }
        const tex = new THREE.CanvasTexture(c);
        tex.wrapS = THREE.RepeatWrapping;
        return tex;
      }
      const reelTex = makeReelTexture();
      const slotGroup = new THREE.Group();
      picked.forEach(function(t) {
        const machine = new THREE.Group();
        const ped = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.25, 0.9), darkMat);
        ped.position.y = 0.12; ped.castShadow = true; machine.add(ped);
        const pedTrim = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.06, 0.94), goldMat);
        pedTrim.position.y = 0.27; machine.add(pedTrim);
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.2, 0.7), greenMat);
        body.position.y = 0.9; body.castShadow = true; machine.add(body);
        const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.6), darkMat);
        sideL.position.set(-0.46, 0.9, 0); machine.add(sideL);
        const sideR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.6), darkMat);
        sideR.position.set(0.46, 0.9, 0); machine.add(sideR);
        const winFrame = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.5, 0.1), goldMat);
        winFrame.position.set(0, 1.05, 0.32); machine.add(winFrame);
        const winBg = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.42, 0.06), darkMat);
        winBg.position.set(0, 1.05, 0.35); machine.add(winBg);
        machine.userData.reels = [];
        for (let i = -1; i <= 1; i++) {
          const reelGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.22, 16);
          const reelMat2 = new THREE.MeshLambertMaterial({ map: reelTex.clone() });
          reelMat2.map.needsUpdate = true;
          const reel = new THREE.Mesh(reelGeo, reelMat2);
          reel.rotation.z = Math.PI / 2;
          reel.rotation.y = Math.PI / 2;
          reel.position.set(i * 0.22, 1.05, 0.39);
          machine.add(reel);
          machine.userData.reels.push(reel);
          reel.userData.spinAngle = 0;
          reel.userData.targetAngle = 0;
          reel.userData.spinning = false;
        }
        const marquee = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.28, 0.74), darkMat);
        marquee.position.y = 1.64; marquee.castShadow = true; machine.add(marquee);
        const marqGlow = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.1, 0.76), glowPink);
        marqGlow.position.y = 1.8; machine.add(marqGlow);
        for (let li = 0; li < 5; li++) {
          const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), li % 2 ? glowPink : glowCyan);
          bulb.position.set(-0.36 + li * 0.18, 1.64, 0.38); machine.add(bulb);
        }
        const leverBase = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 10), darkMat);
        leverBase.position.set(0.5, 1.2, 0); leverBase.rotation.z = Math.PI/2; machine.add(leverBase);
        const leverArm = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.55, 8), leverMat);
        leverArm.position.set(0.58, 1.45, 0); leverArm.rotation.z = -0.35; machine.add(leverArm);
        machine.userData.leverArm = leverArm;
        const leverBall = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), glowPink);
        leverBall.position.set(0.68, 1.7, 0); machine.add(leverBall);
        const tray = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.2), darkMat);
        tray.position.set(0, 0.38, 0.4); machine.add(tray);
        machine.position.set(t.c + 0.5, 0.35, t.r + 0.5);
        machine.userData.isWoodsSlot = true;
        machine.userData.phase = Math.random() * 6.28;
        slotGroup.add(machine);
      });
      worldGroup.add(slotGroup);
      if (!worldGroup.userData.woodsSlots) worldGroup.userData.woodsSlots = [];
      slotGroup.children.forEach(function(m) { worldGroup.userData.woodsSlots.push(m); });
    })();

    // Decorative walk-through bushes: small green blobs scattered on grass.
    // Purely visual — NOT in the collision map, you walk right through them.
    (function addBushes(){
      const grassSpots = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const idx = M.map[r][c];
        if (idx < 0 || idx >= tiles.length) continue;
        const nm = (tiles[idx] || "").toLowerCase();
        if (/grass/i.test(nm) && !/tree/i.test(nm)) grassSpots.push({ c: c, r: r });
      }
      if (!grassSpots.length) return;
      const bushGeo = new THREE.IcosahedronGeometry(0.32, 0);
      const bushMat = new THREE.MeshLambertMaterial({ color: 0x3fae4a });
      const bushMat2 = new THREE.MeshLambertMaterial({ color: 0x2e8b3a });
      const N = Math.min(28, Math.floor(grassSpots.length / 8));
      for (let i = 0; i < N; i++) {
        const s = grassSpots[Math.floor(Math.random() * grassSpots.length)];
        const b = new THREE.Mesh(bushGeo, Math.random() < 0.5 ? bushMat : bushMat2);
        const sc = 0.7 + Math.random() * 0.7;
        b.scale.set(sc, sc * 0.75, sc);
        b.position.set(s.c + 0.5 + (Math.random() - 0.5) * 0.3, 0.35 + 0.18 * sc, s.r + 0.5 + (Math.random() - 0.5) * 0.3);
        b.castShadow = true;
        worldGroup.add(b);
      }
    })();

    // Soft ground plane far below for shadow catching (diorama sits in space)
    // Actually skip — fog handles the void

    // Position camera default
    updateCamera((cols - 1) / 2, (rows - 1) / 2, true);
  }

  // Diorama camera: straight-on front view with just a slight tilt — clean 2.5D.
  // Follows the player smoothly, angle never changes.
  let camTarget = { x: 0, z: 0 };
  function updateCamera(px, pz, snap) {
    const tx = px, tz = pz;
    if (snap) { camTarget.x = tx; camTarget.z = tz; }
    else {
      camTarget.x += (tx - camTarget.x) * 0.08;
      camTarget.z += (tz - camTarget.z) * 0.08;
    }
    camera.position.set(camTarget.x + 1.5, 4.2, camTarget.z + 9.0);
    camera.lookAt(camTarget.x, 0.5, camTarget.z);
  }

  // Character sprite (billboard, preserves 2D art).
  // Y-position adjusts to the tile height so the character sits ON the ground
  // (sunken paths, water edges) instead of floating.
  function groundYAt(tx, tz) {
    if (!mapData) return 0;
    const c = Math.floor(tx), r = Math.floor(tz);
    if (c < 0 || r < 0 || c >= mapData.cols || r >= mapData.rows) return 0;
    const idx = mapData.map[r][c];
    const tiles = mapData.tiles || [];
    if (idx < 0 || idx >= tiles.length) return 0;
    const name = tiles[idx];
    const solid = mapData.solid && mapData.solid[r] && mapData.solid[r][c];
    if (isTreeTile(name)) return 0;  // character never stands on a tree
    const h = tileHeight(name, solid);
    return h < 0 ? 0 : h;
  }
  // Character as EXTRUDED 3D sprite: Coby's actual sprite art traced and given depth.
  // Like the dreamlings — the real outline, not a blocky humanoid.
  const charGeoCache = {};
  function getCharGeo(spriteIm, key) {
    if (charGeoCache[key]) return charGeoCache[key];
    const shape = maskToShape(spriteIm);
    if (!shape) return null;
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.45, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.08, bevelSegments: 2
    });
    geo.center();
    geo.computeBoundingBox();
    const bb = geo.boundingBox, size = new THREE.Vector3();
    bb.getSize(size);
    const uv = geo.attributes.uv, pos = geo.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (pos.getX(i) - bb.min.x) / size.x, (pos.getY(i) - bb.min.y) / size.y);
    }
    charGeoCache[key] = geo;
    return geo;
  }
  function setCharacter(textureUrl, x, z, bounceY) {
    const rurl = resolveUrl(textureUrl);
    if (!charSprite) {
      charSprite = new THREE.Group();
      charSprite.userData.url = rurl;
      charSprite.userData.geoBuilt = false;
      scene.add(charSprite);
      // Load the sprite, trace it, extrude it
      const im = new Image();
      im.onload = function() {
        const geo = getCharGeo(im, rurl);
        if (!charSprite) return;
        let mesh;
        if (geo) {
          const tex = new THREE.TextureLoader().load(rurl);
          tex.magFilter = THREE.NearestFilter;
          const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.1 });
          mesh = new THREE.Mesh(geo, mat);
          mesh.scale.set(1.4, 1.6, 1.4);
          charSprite.userData.mat = mat;
        } else {
          // Fallback: simple 3D figure if tracing fails (never vanish)
          const fbMat = new THREE.MeshLambertMaterial({ color: 0x8a6aba });
          mesh = new THREE.Group();
          const b1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.4), fbMat);
          b1.position.y = 1.25; mesh.add(b1);
          const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.35), fbMat);
          b2.position.y = 0.65; mesh.add(b2);
        }
        mesh.castShadow = true;
        // Clear any old mesh first
        while (charSprite.children.length > 0) charSprite.remove(charSprite.children[0]);
        charSprite.add(mesh);
        charSprite.userData.mesh = mesh;
        charSprite.userData.geoBuilt = true;
      };
      im.onerror = function() {
        // Sprite 404: fallback figure so the character never vanishes
        if (!charSprite || charSprite.userData.geoBuilt) return;
        const fbMat = new THREE.MeshLambertMaterial({ color: 0x8a6aba });
        const mesh = new THREE.Group();
        const b1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.4), fbMat);
        b1.position.y = 1.25; b1.castShadow = true; mesh.add(b1);
        const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.35), fbMat);
        b2.position.y = 0.65; b2.castShadow = true; mesh.add(b2);
        while (charSprite.children.length > 0) charSprite.remove(charSprite.children[0]);
        charSprite.add(mesh);
        charSprite.userData.mesh = mesh;
        charSprite.userData.geoBuilt = true;
      };
      im.src = rurl;
    }
    const gy = groundYAt(x, z);
    charSprite.position.set(x, gy + 0.8 + (bounceY || 0), z);
    // Subtle lean into movement (bounceY indicates motion)
    if (charSprite.userData.mesh && bounceY) {
      charSprite.userData.mesh.rotation.y = Math.sin(performance.now() / 300) * 0.15;
    }
  }

  function setCharacterTexture(url) {
    url = resolveUrl(url);
    if (!charTextures[url]) {
      const tex = new THREE.TextureLoader().load(url);
      tex.magFilter = THREE.NearestFilter;
      charTextures[url] = tex;
    }
    // Rebuild the extruded sprite with the new texture (different outfit/area)
    if (charSprite && charSprite.userData.url !== url) {
      charSprite.userData.url = url;
      charSprite.userData.geoBuilt = false;
      // Clear old mesh
      while (charSprite.children.length > 0) {
        const c = charSprite.children[0];
        charSprite.remove(c);
        if (c.geometry) c.geometry.dispose();
      }
      const im = new Image();
      im.onload = function() {
        const geo = getCharGeo(im, url);
        if (!geo || !charSprite) return;
        const mat = new THREE.MeshLambertMaterial({ map: charTextures[url], transparent: true, alphaTest: 0.1 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.scale.set(1.4, 1.6, 1.4);
        charSprite.add(mesh);
        charSprite.userData.mesh = mesh;
        charSprite.userData.mat = mat;
        charSprite.userData.geoBuilt = true;
      };
      im.src = url;
    }
  }

  // Companion dreamling: animated billboard sprite that orbits/bobs in 3D
  let companionTexCache = {};
  // NPC sprite (BOB) — billboard like the character, with a gentle idle bob
  let npcSprite = null, npcTexCache = {};
  function setNPC(textureUrl, x, z, time, visible) {
    if (!visible || !textureUrl) {
      if (npcSprite) npcSprite.visible = false;
      return;
    }
    const rurl = resolveUrl(textureUrl);
    if (!npcSprite) {
      const tex = new THREE.TextureLoader().load(rurl);
      tex.magFilter = THREE.NearestFilter;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
      npcSprite = new THREE.Sprite(mat);
      npcSprite.scale.set(1.0, 1.4, 1);
      scene.add(npcSprite);
      npcTexCache[rurl] = tex;
    } else if (npcSprite.material.map !== npcTexCache[rurl]) {
      if (!npcTexCache[rurl]) {
        const tex = new THREE.TextureLoader().load(rurl);
        tex.magFilter = THREE.NearestFilter;
        npcTexCache[rurl] = tex;
      }
      npcSprite.material.map = npcTexCache[rurl];
      npcSprite.material.needsUpdate = true;
    }
    npcSprite.visible = true;
    const bob = Math.sin(time / 500) * 0.05;
    const gy = groundYAt(x, z);
    npcSprite.position.set(x, gy + 0.7 + bob, z);
  }
  // Companion 3D models: OBJ+MTL files in models/ (uploaded extracted).
  // The slab below stays as the instant fallback; the OBJ swaps in once loaded.
  // Slots are untouched: they keep using the 2D dreamling sprites.
  let companionObj = null;
  const companionModelCache = {};
  const companionModelLoading = {};
  const companionModelFailed = {};
  function parseMTL(text) {
    const mats = {};
    let cur = null;
    text.split(/\r?\n/).forEach(function(line) {
      const p = line.trim().split(/\s+/);
      if (p[0] === 'newmtl') { cur = p[1]; mats[cur] = [1, 1, 1]; }
      else if (p[0] === 'Kd' && cur) mats[cur] = [parseFloat(p[1]) || 0, parseFloat(p[2]) || 0, parseFloat(p[3]) || 0];
    });
    return mats;
  }
  function buildCompanionModel(objText, mtlText) {
    const mats = mtlText ? parseMTL(mtlText) : {};
    const verts = [];
    const pos = [], col = [];
    let cur = null;
    objText.split(/\r?\n/).forEach(function(line) {
      const p = line.trim().split(/\s+/);
      if (!p[0]) return;
      if (p[0] === 'v') verts.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
      else if (p[0] === 'usemtl') cur = p[1];
      else if (p[0] === 'f') {
        const idx = p.slice(1).map(function(t) { return parseInt(t.split('/')[0], 10) - 1; });
        const c = (cur && mats[cur]) ? mats[cur] : [1, 1, 1];
        const tris = [[idx[0], idx[1], idx[2]]];
        if (idx.length >= 4) tris.push([idx[0], idx[2], idx[3]]);
        tris.forEach(function(t) {
          t.forEach(function(vi) {
            const v = verts[vi];
            if (!v) return;
            pos.push(v[0], v[1], v[2]);
            col.push(c[0], c[1], c[2]);
          });
        });
      }
    });
    if (!pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    geo.center();
    geo.computeBoundingBox();
    const h = geo.boundingBox.max.y - geo.boundingBox.min.y || 1;
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.scale.setScalar(1.3 / h);
    mesh.castShadow = true;
    const g = new THREE.Group();
    g.add(mesh);
    return g;
  }
  function loadCompanionModel(num) {
    if (companionModelCache[num] || companionModelLoading[num] || companionModelFailed[num]) return;
    companionModelLoading[num] = true;
    // Models were uploaded to the repo ROOT, not models/ — try root first, then models/.
    // The MTL is resolved relative to whichever directory the OBJ was found in.
    const dirs = ['', 'models/'];
    function tryObj(di) {
      if (di >= dirs.length) throw new Error('obj 404');
      return fetch(dirs[di] + 'dreamlingP' + num + '.obj').then(function(r) {
        if (!r.ok) return tryObj(di + 1);
        return r.text().then(function(objText) { return { dir: dirs[di], objText: objText }; });
      });
    }
    tryObj(0)
      .then(function(found) {
        const mm = found.objText.match(/^mtllib\s+(\S+)/m);
        if (!mm) return { objText: found.objText, mtlText: null };
        return fetch(found.dir + mm[1]).then(function(r) { if (!r.ok) throw new Error('mtl ' + r.status); return r.text(); })
          .then(function(mtlText) { return { objText: found.objText, mtlText: mtlText }; });
      })
      .then(function(parts) {
        const g = buildCompanionModel(parts.objText, parts.mtlText);
        if (!g) throw new Error('parse');
        companionModelCache[num] = g;
        delete companionModelLoading[num];
      })
      .catch(function() { delete companionModelLoading[num]; companionModelFailed[num] = true; });
  }
  function setCompanion(textureUrl, x, z, time) {
    if (!textureUrl) {
      if (companionSprite) { scene.remove(companionSprite); companionSprite = null; }
      if (companionObj) { scene.remove(companionObj); companionObj = null; }
      return;
    }
    const numMatch = ("" + textureUrl).match(/dreamlingP(\d+)\.png/);
    const num = numMatch ? parseInt(numMatch[1], 10) : -1;
    // Bobbing animation + ORBIT around the character (circles you, dreamling-style)
    const bob = Math.sin(time / 450) * 0.18;
    const orbitR = 1.4;
    const orbitA = time / 1400;  // one lap every ~9 seconds
    const ox = Math.cos(orbitA) * orbitR;
    const oz = Math.sin(orbitA) * orbitR;
    const pulse = 1 + Math.sin(time / 600) * 0.06;
    // 3D OBJ model when it has loaded; slab otherwise (and while loading)
    if (num > 0 && companionModelCache[num]) {
      if (companionObj !== companionModelCache[num]) {
        if (companionSprite) { scene.remove(companionSprite); companionSprite = null; }
        if (companionObj) scene.remove(companionObj);
        companionObj = companionModelCache[num];
        scene.add(companionObj);
      }
      companionObj.position.set(x + ox, 1.1 + bob, z + oz);
      companionObj.rotation.y = orbitA + Math.PI / 2;  // face tangent to orbit
      companionObj.scale.set(pulse, pulse, pulse);
      return;
    }
    const rurl = resolveUrl(textureUrl);
    if (!companionSprite) {
      const tex = new THREE.TextureLoader().load(rurl);
      tex.magFilter = THREE.NearestFilter;
      // 3D companion: thin extruded slab like the floaters
      const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.1 });
      const geo = new THREE.BoxGeometry(1.0, 1.0, 0.2);
      companionSprite = new THREE.Mesh(geo, mat);
      companionSprite.castShadow = true;
      companionSprite.userData.mat = mat;
      scene.add(companionSprite);
      companionTexCache[rurl] = tex;
    } else if (!companionTexCache[rurl]) {
      const tex = new THREE.TextureLoader().load(rurl);
      tex.magFilter = THREE.NearestFilter;
      companionTexCache[rurl] = tex;
      companionSprite.userData.mat.map = tex;
      companionSprite.userData.mat.needsUpdate = true;
    } else if (companionSprite.userData.mat.map !== companionTexCache[rurl]) {
      companionSprite.userData.mat.map = companionTexCache[rurl];
      companionSprite.userData.mat.needsUpdate = true;
    }
    companionSprite.position.set(x + ox, 1.1 + bob, z + oz);
    companionSprite.rotation.y = orbitA + Math.PI / 2;  // face tangent to orbit
    companionSprite.scale.set(pulse, pulse, 1);
    // Kick off the OBJ load in the background (slab stays until it arrives)
    if (num > 0) loadCompanionModel(num);
  }

  // Render one frame
  function render(px, pz) {
    if (!initialized) return;
    updateCamera(px, pz, false);
    renderer.render(scene, camera);
  }

  // ===== 3D BUILDINGS (generator + warp huts) =====
  // buildGenerator clears and builds the main generator; addBuilding adds extra
  // structures (warp huts, Bob's house) without clearing.
  function buildGenerator(gx, gy, gw, gh) {
    clearGenerator();
    genGroup = new THREE.Group();
    worldGroup.add(genGroup);
    addBuildingTo(genGroup, gx, gy, gw, gh, "generator");
    genGroup.userData.orb = genGroup.userData.orb || null;
  }

  function addBuilding(gx, gy, gw, gh, style) {
    if (!genGroup) { genGroup = new THREE.Group(); worldGroup.add(genGroup); }
    addBuildingTo(genGroup, gx, gy, gw, gh, style || "hut");
  }

  function addBuildingTo(group, gx, gy, gw, gh, style) {
    const isGen = (style === "generator");
    const wallMat = new THREE.MeshLambertMaterial({ color: isGen ? 0x3d2670 : 0x8a6a4a });
    const trimMat = new THREE.MeshLambertMaterial({ color: isGen ? 0x6a4a9a : 0x6b4a2f });
    const roofMat = new THREE.MeshLambertMaterial({ color: isGen ? 0x1a0f2e : 0x4a3020 });
    const glowMat = new THREE.MeshBasicMaterial({ color: isGen ? 0x8affea : 0xffd27a });
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const WALL_H = isGen ? 2.2 : 1.8;
    const cx0 = gx + gw / 2, cz0 = gy + gh / 2;

    for (let cx = 0; cx < gw; cx++) {
      for (let cz = 0; cz < gh; cz++) {
        const wall = new THREE.Mesh(boxGeo, wallMat);
        wall.position.set(gx + cx + 0.5, WALL_H / 2, gy + cz + 0.5);
        wall.scale.set(0.96, WALL_H, 0.96);
        wall.castShadow = true; wall.receiveShadow = true;
        group.add(wall);
      }
    }
    // PIZZAZZ: glowing trim strip along the top of the walls
    const trimGlow = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ color: isGen ? 0xb388ff : 0xffc36a }));
    trimGlow.position.set(cx0, WALL_H + 0.02, cz0);
    trimGlow.scale.set(gw + 0.1, 0.07, gh + 0.1);
    group.add(trimGlow);
    const trim = new THREE.Mesh(boxGeo, trimMat);
    trim.position.set(cx0, WALL_H + 0.12, cz0);
    trim.scale.set(gw + 0.15, 0.14, gh + 0.15);
    trim.castShadow = true;
    group.add(trim);
    // PIZZAZZ: corner pillars
    const pillarGeo = new THREE.BoxGeometry(0.22, WALL_H + 0.3, 0.22);
    const pillarMat = new THREE.MeshLambertMaterial({ color: isGen ? 0x5a3a8a : 0x5a4028 });
    [[gx, gy], [gx + gw, gy], [gx, gy + gh], [gx + gw, gy + gh]].forEach(function(p) {
      const pil = new THREE.Mesh(pillarGeo, pillarMat);
      pil.position.set(p[0] + 0.5 - (p[0] > gx ? 1 : 0) + (p[0] === gx ? -0.05 : 0.05), (WALL_H + 0.3) / 2, p[1] + 0.5 - (p[1] > gy ? 1 : 0) + (p[1] === gy ? -0.05 : 0.05));
      pil.castShadow = true;
      group.add(pil);
      // glowing cap on each pillar
      const cap = new THREE.Mesh(boxGeo, glowMat);
      cap.position.set(pil.position.x, WALL_H + 0.32, pil.position.z);
      cap.scale.set(0.28, 0.1, 0.28);
      group.add(cap);
    });
    const roof = new THREE.Mesh(boxGeo, roofMat);
    roof.position.set(cx0, WALL_H + 0.36, cz0);
    roof.scale.set(gw + 0.5, 0.35, gh + 0.5);
    roof.castShadow = true;
    group.add(roof);
    // PIZZAZZ: one small glowing window per side, centered, no overlap.
    // Front window sits high above the door with clear space between.
    const winMat = new THREE.MeshBasicMaterial({ color: isGen ? 0x8affea : 0xffe0a0 });
    const winGeo = new THREE.BoxGeometry(0.4, 0.5, 0.06);
    const winY = WALL_H * 0.62;
    const winYFront = WALL_H * 0.78;  // raised: clear gap above the door
    // front (high)
    const wF = new THREE.Mesh(winGeo, winMat);
    wF.position.set(cx0, winYFront, gy + gh + 0.02); group.add(wF);
    // back
    const wB = new THREE.Mesh(winGeo, winMat);
    wB.position.set(cx0, winY, gy - 0.02); group.add(wB);
    // left
    const wL = new THREE.Mesh(winGeo, winMat);
    wL.position.set(gx - 0.02, winY, cz0); wL.rotation.y = Math.PI / 2; group.add(wL);
    // right
    const wR = new THREE.Mesh(winGeo, winMat);
    wR.position.set(gx + gw + 0.02, winY, cz0); wR.rotation.y = Math.PI / 2; group.add(wR);
    if (isGen) {
      const peak = new THREE.Mesh(boxGeo, trimMat);
      peak.position.set(cx0, WALL_H + 0.66, cz0);
      peak.scale.set(gw * 0.5, 0.25, gh * 0.5);
      peak.castShadow = true;
      group.add(peak);
      // PIZZAZZ: bigger orb + glow ring + orbiting crystals
      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 20, 20),
        new THREE.MeshBasicMaterial({ color: 0xd0a0ff })
      );
      orb.position.set(cx0, WALL_H + 1.1, cz0);
      group.add(orb);
      group.userData.orb = orb;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.62, 0.05, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0x8affea })
      );
      ring.position.copy(orb.position);
      ring.rotation.x = Math.PI / 2.4;
      group.add(ring);
      group.userData.orbRing = ring;
      // 3 floating crystals orbiting the orb
      const cryGeo = new THREE.OctahedronGeometry(0.14);
      const cryMat = new THREE.MeshBasicMaterial({ color: 0x8affea });
      group.userData.crystals = [];
      for (let i = 0; i < 3; i++) {
        const c = new THREE.Mesh(cryGeo, cryMat);
        group.add(c);
        group.userData.crystals.push(c);
      }
    }
    // Door glow on front face
    const door = new THREE.Mesh(boxGeo, glowMat);
    door.position.set(cx0, 0.55, gy + gh + 0.03);
    door.scale.set(0.6, 1.1, 0.08);
    group.add(door);
    // PIZZAZZ: door frame glow
    const frame = new THREE.Mesh(boxGeo, trimMat);
    frame.position.set(cx0, 0.55, gy + gh + 0.01);
    frame.scale.set(0.78, 1.28, 0.05);
    group.add(frame);
    door.position.z = gy + gh + 0.04;  // door in front of frame
  }

  function clearGenerator() {
    if (genGroup) {
      worldGroup.remove(genGroup);
      genGroup = null;
    }
  }

  // ===== 3D DREAM FLOATERS (billboard sprites in voxel space) =====
  // New format: f.sheet = JPEG strip of thumbnails, f.mask = PNG dreamling shape.
  // Legacy: f.imgs[] thumbnails, f.num for dreamlingP silhouette.
  // The sprite is ALWAYS the dreamling's outline — never a square, never a circle.
  const floaterSilhouettes = {};
  function getSilhouette(num) {
    if (num == null) return null;
    if (!floaterSilhouettes[num]) {
      const im = new Image();
      im.onload = function() { refreshFloaterTextures(); };
      im.src = resolveUrl("dreamlingP" + num + ".png");
      floaterSilhouettes[num] = im;
    }
    return floaterSilhouettes[num];
  }
  function compositeFloater(spr) {
    const f = spr.userData.floater;
    if (!f) return;
    const cv = spr.userData.canvas, cx = cv.getContext("2d");
    const S = cv.width;
    cx.globalCompositeOperation = "source-over";
    cx.clearRect(0, 0, S, S);
    const idx = Math.floor(performance.now() / 120) % 8;
    let drew = false;
    if (f.sheet && f.sheet.complete && f.sheet.naturalWidth && f.mask && f.mask.complete && f.mask.naturalWidth) {
      // New format: draw the current thumbnail from the sheet, clipped by the mask shape
      const n = f.n || 8, sw = f.sheet.naturalWidth / n;
      const sx = Math.min(idx, n - 1) * sw;
      cx.drawImage(f.sheet, sx, 0, sw, f.sheet.naturalHeight, 0, 0, S, S);
      cx.globalCompositeOperation = "destination-in";
      // Draw mask slightly inset (2px) to shave off any outer halo ring — just the outline
      cx.drawImage(f.mask, 2, 2, S - 4, S - 4);
      drew = true;
    } else if (f.imgs && f.imgs.length) {
      // Legacy format
      const texes = spr.userData.texes;
      const thumb = (texes && texes.length) ? texes[idx % texes.length] : null;
      if (thumb && thumb.image && thumb.image.complete && thumb.image.naturalWidth) {
        const tw = thumb.image.naturalWidth, th = thumb.image.naturalHeight;
        const sc = Math.max(S / tw, S / th), dw = tw * sc, dh = th * sc;
        cx.drawImage(thumb.image, (S - dw) / 2, (S - dh) / 2, dw, dh);
        cx.globalCompositeOperation = "destination-in";
        const sil = getSilhouette(f.num);
        if (sil && sil.complete && sil.naturalWidth) cx.drawImage(sil, 0, 0, S, S);
        else { cx.beginPath(); cx.arc(S / 2, S / 2, S * 0.42, 0, 7); cx.fill(); }
        drew = true;
      }
    }
    cx.globalCompositeOperation = "source-over";
    if (drew) spr.userData.ctex.needsUpdate = true;
  }
  function refreshFloaterTextures() {
    for (const spr of floaterSprites) compositeFloater(spr);
  }
  // Returns true if the mask looks like the generator's circular blob fallback
  // (ellipse, not a real dreamling outline). Those floaters are skipped entirely.
  function isBlobMask(maskIm) {
    try {
      const mc = document.createElement("canvas"); mc.width = mc.height = 64;
      const mx = mc.getContext("2d", { willReadFrequently: true });
      mx.drawImage(maskIm, 0, 0, 64, 64);
      const d = mx.getImageData(0, 0, 64, 64).data;
      const alpha = function(x, y) { return d[(y * 64 + x) * 4 + 3]; };
      let solidTop = 0;
      for (const x of [20, 26, 32, 38, 44]) if (alpha(x, 8) > 100) solidTop++;
      const leftSolid = alpha(10, 32) > 100, rightSolid = alpha(54, 32) > 100;
      return solidTop >= 4 && leftSolid && rightSolid;
    } catch (e) { return false; }
  }
  // Trace the outline of a mask image into a THREE.Shape (for extruded 3D dreamlings).
  // Uses Moore-neighbor contour tracing on the alpha channel.
  function maskToShape(maskIm) {
    const S = 64;
    const cv = document.createElement("canvas"); cv.width = cv.height = S;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(maskIm, 0, 0, S, S);
    const d = cx.getImageData(0, 0, S, S).data;
    const solid = function(x, y) {
      if (x < 0 || y < 0 || x >= S || y >= S) return false;
      return d[(y * S + x) * 4 + 3] > 100;
    };
    // Find a starting edge pixel (leftmost solid pixel of the middle row band)
    let sx = -1, sy = -1;
    for (let y = 0; y < S && sx < 0; y++) for (let x = 0; x < S; x++) {
      if (solid(x, y) && !solid(x - 1, y)) { sx = x; sy = y; break; }
    }
    if (sx < 0) return null;
    // Moore-neighbor tracing (8-connectivity, clockwise)
    const dirs = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
    const pts = [];
    let cxp = sx, cyp = sy, dir = 6;  // start facing up
    const maxSteps = 2000;
    for (let step = 0; step < maxSteps; step++) {
      pts.push([cxp, cyp]);
      // Search neighbors clockwise starting from (dir+6)%8
      let found = false;
      for (let i = 0; i < 8; i++) {
        const nd = (dir + 6 + i) % 8;
        const nx = cxp + dirs[nd][0], ny = cyp + dirs[nd][1];
        if (solid(nx, ny)) {
          cxp = nx; cyp = ny; dir = nd; found = true;
          break;
        }
      }
      if (!found) break;
      if (cxp === sx && cyp === sy && pts.length > 10) break;  // closed loop
    }
    if (pts.length < 10) return null;
    // Simplify: keep every 3rd point to reduce vertex count
    const simp = [];
    for (let i = 0; i < pts.length; i += 3) simp.push(pts[i]);
    // Build THREE.Shape (flip Y, center at origin, scale to ~1.3 units)
    const shape = new THREE.Shape();
    const sc = 1.3 / S;
    simp.forEach(function(p, i) {
      const x = (p[0] - S / 2) * sc, y = (S / 2 - p[1]) * sc;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });
    shape.closePath();
    return shape;
  }
  // Cache of extruded geometries by mask URL (so we don't re-trace every time)
  const extrudeGeoCache = {};
  function getExtrudedDreamling(maskIm, maskKey) {
    if (extrudeGeoCache[maskKey]) return extrudeGeoCache[maskKey];
    const shape = maskToShape(maskIm);
    if (!shape) return null;
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.7, bevelEnabled: true, bevelThickness: 0.18, bevelSize: 0.14, bevelSegments: 3
    });
    geo.center();
    // Fix UVs: ExtrudeGeometry UVs are in shape units; remap to 0-1 for the texture
    geo.computeBoundingBox();
    const bb = geo.boundingBox, size = new THREE.Vector3();
    bb.getSize(size);
    const uv = geo.attributes.uv, pos = geo.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (pos.getX(i) - bb.min.x) / size.x, (pos.getY(i) - bb.min.y) / size.y);
    }
    extrudeGeoCache[maskKey] = geo;
    return geo;
  }
  // Returns true if the mask looks like the generator's circular blob fallback
  // (ellipse, not a real dreamling outline). Those floaters are skipped entirely.
  function isBlobMask(maskIm) {
    try {
      const mc = document.createElement("canvas"); mc.width = mc.height = 64;
      const mx = mc.getContext("2d", { willReadFrequently: true });
      mx.drawImage(maskIm, 0, 0, 64, 64);
      const d = mx.getImageData(0, 0, 64, 64).data;
      const alpha = function(x, y) { return d[(y * 64 + x) * 4 + 3]; };
      // Blob ellipse: center (32,32), rx~23, ry~27. A real dreamling silhouette
      // has transparent gaps near the top edge; the blob is solid there.
      // Sample 5 points across the top of the blob area.
      let solidTop = 0;
      for (const x of [20, 26, 32, 38, 44]) if (alpha(x, 8) > 100) solidTop++;
      // Also check: blob is symmetric — left and right edges at mid-height are solid
      const leftSolid = alpha(10, 32) > 100, rightSolid = alpha(54, 32) > 100;
      return solidTop >= 4 && leftSolid && rightSolid;
    } catch (e) { return false; }
  }
  function setFloaters(list) {
    for (const s of floaterSprites) scene.remove(s);
    floaterSprites = [];
    for (const f of list) {
      const hasNew = !!(f.sheet && f.mask);
      const hasLegacy = !!(f.imgs && f.imgs.length);
      if (!hasNew && !hasLegacy) continue;
      const cv = document.createElement("canvas");
      cv.width = cv.height = 64;
      const ctex = new THREE.CanvasTexture(cv);
      ctex.magFilter = THREE.NearestFilter;
      // Dreamling as EXTRUDED 3D outline: the 2D silhouette traced and given depth.
      // The dream video plays on its faces, cycling thumbnails. Not a sphere, not a billboard.
      const mat = new THREE.MeshLambertMaterial({ map: ctex, transparent: true, alphaTest: 0.1 });
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);  // geo swapped in when mask loads
      mesh.castShadow = true;
      mesh.position.set(f.hx + 0.5, 1.6, f.hy + 0.5);
      mesh.userData.floater = f;
      mesh.userData.canvas = cv;
      mesh.userData.ctex = ctex;
      mesh.userData.thumbIdx = -1;
      mesh.userData.isFloaterMesh = true;
      mesh.userData.blobChecked = false;
      mesh.userData.geoReady = false;
      if (hasLegacy) {
        mesh.userData.texes = f.imgs.map(function(im){ return { image: im }; });
        getSilhouette(f.num);
      }
      // Build the extruded outline once the mask is ready. Blob masks are culled.
      const buildGeo = function() {
        if (mesh.userData.blobChecked) return;
        mesh.userData.blobChecked = true;
        if (!f.mask.complete || !f.mask.naturalWidth) return;
        if (isBlobMask(f.mask)) {
          scene.remove(mesh);
          const i = floaterSprites.indexOf(mesh);
          if (i >= 0) floaterSprites.splice(i, 1);
          return;
        }
        const maskKey = f.mask.src || ("mask" + floaterSprites.length);
        const geo = getExtrudedDreamling(f.mask, maskKey);
        if (geo) {
          mesh.geometry.dispose();
          mesh.geometry = geo;
          mesh.userData.geoReady = true;
          compositeFloater(mesh);
        }
      };
      if (f.mask) {
        if (f.mask.complete && f.mask.naturalWidth) buildGeo();
        else f.mask.onload = buildGeo;
      } else {
        // Legacy: no mask, use a simple extruded blob shape
        mesh.userData.geoReady = true;
        compositeFloater(mesh);
      }
      scene.add(mesh);
      floaterSprites.push(mesh);
    }
  }

  function animateFloaters(time) {
    for (const spr of floaterSprites) {
      const f = spr.userData.floater;
      if (!f) continue;
      // Wander around their home tile — 3x the 2D speed so motion is clearly visible
      const wsp = f.sp * 3;
      const wx = f.hx + Math.sin(time * wsp + f.ph) * f.rg;
      const wz = f.hy + Math.cos(time * wsp * 0.77 + f.ph * 1.3) * f.rg * 0.7;
      const bob = Math.sin(time / 450 + f.ph) * 0.22;
      spr.position.set(wx + 0.5, 1.6 + bob, wz + 0.5);
      // Gentle spin so the 3D form reads from all angles
      if (spr.userData.isFloaterMesh) spr.rotation.y += 0.008;
      // Re-composite when the thumbnail cycles (fast card animation)
      const texes = spr.userData.texes;
      if (texes && texes.length > 1) {
        const idx = Math.floor(time / 120) % texes.length;
        if (idx !== spr.userData.thumbIdx) {
          spr.userData.thumbIdx = idx;
          compositeFloater(spr);
        }
      } else if (f.sheet) {
        // New format: 8 thumbnails in the sheet, cycle every 120ms
        const idx = Math.floor(time / 120) % 8;
        if (idx !== spr.userData.thumbIdx) {
          spr.userData.thumbIdx = idx;
          compositeFloater(spr);
        }
      }
    }
    // Pulse the generator orb + spin ring + orbit crystals
    if (genGroup && genGroup.userData.orb) {
      const s = 1 + Math.sin(time / 380) * 0.15;
      genGroup.userData.orb.scale.set(s, s, s);
      if (genGroup.userData.orbRing) genGroup.userData.orbRing.rotation.z = time / 900;
      if (genGroup.userData.crystals) {
        const orbP = genGroup.userData.orb.position;
        genGroup.userData.crystals.forEach(function(c, i) {
          const a = time / 700 + i * 2.094;
          c.position.set(orbP.x + Math.cos(a) * 0.85, orbP.y + Math.sin(time / 500 + i) * 0.18, orbP.z + Math.sin(a) * 0.85);
          c.rotation.y = time / 400 + i;
          c.rotation.x = time / 550;
        });
      }
    }
  }

  // Animate water (subtle y bob on water instances)
    // Pulse the water slot machine symbols (encounter slot removed - Coby didn't want the giant machine)
  function animate(time) {
    animateFloaters(time);
    // Waking Woods green machines: slow rotation + idle reel drift
    if (worldGroup && worldGroup.userData.woodsSlots) {
      worldGroup.userData.woodsSlots.forEach(function(m) {
        m.rotation.y = Math.sin(time / 1400 + m.userData.phase) * 0.3;
        if (m.userData.reels) m.userData.reels.forEach(function(reel) {
          reel.userData.spinAngle += 0.008;
          reel.userData.targetAngle = reel.userData.spinAngle;
          reel.rotation.x = reel.userData.spinAngle;
        });
        if (m.userData.leverArm) m.userData.leverArm.rotation.z = -0.35 + Math.sin(time / 900 + m.userData.phase) * 0.15;
      });
    }
    // Encounter cabinet machine: float in front of the camera, facing it
    if (encMachine && encMachine.visible && camera) {
      camera.getWorldDirection(_camDir);
      encMachine.position.copy(camera.position).addScaledVector(_camDir, 4.6);
      encMachine.lookAt(camera.position);
      // Reel faces scroll their strip texture while spinning; static otherwise
      if (encMachine.userData.reels) encMachine.userData.reels.forEach(function(reel) {
        if (reel.userData.scrolling && reel.userData.stripTex) reel.userData.stripTex.offset.y -= 0.22;
      });
      if (encMachine.userData.leverArm) encMachine.userData.leverArm.rotation.z = -0.35 + Math.sin(time / 900) * 0.15;
    }
    // Bob the water slot machines and spin their reels
    if (worldGroup && worldGroup.userData.waterSlots) {
      worldGroup.userData.waterSlots.forEach(function(m) {
        m.position.y = m.userData.baseY + Math.sin(time / 600 + m.userData.phase) * 0.12;
        m.rotation.y = Math.sin(time / 1200 + m.userData.phase) * 0.25;
        // Spin the 3D reels (correct slot machine animation)
        if (m.userData.reels) {
          m.userData.reels.forEach(function(reel, ri) {
            if (reel.userData.spinning) {
              // Fast spin during encounter
              reel.userData.spinAngle += 0.35;
              reel.rotation.x = reel.userData.spinAngle;
            } else if (Math.abs(reel.userData.spinAngle - reel.userData.targetAngle) > 0.01) {
              // Ease to target when stopping
              const diff = reel.userData.targetAngle - reel.userData.spinAngle;
              reel.userData.spinAngle += diff * 0.15;
              reel.rotation.x = reel.userData.spinAngle;
            } else {
              // Idle: slow drift so the machines look alive on the water
              reel.userData.spinAngle += 0.008;
              reel.userData.targetAngle = reel.userData.spinAngle;
              reel.rotation.x = reel.userData.spinAngle;
            }
          });
        }
        // Pump the lever
        if (m.userData.leverArm) {
          m.userData.leverArm.rotation.z = -0.35 + Math.sin(time / 900 + m.userData.phase) * 0.15;
        }
      });
    }
  }

  // ---- Encounter cabinet machine: gold-trimmed arcade cabinet, one centered dreamling per reel ----
  // Flat face textures (unlit = bright and readable): a single dreamling, and a vertical
  // strip of dreamlings that scrolls while the reel spins. Dark bg so the dreamlings'
  // black backgrounds blend instead of blowing out white like the old wrapped drums.
  function makeReelFaceCanvas(rolledNum) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    function draw() {
      ctx.fillStyle = '#0d0d14'; ctx.fillRect(0, 0, 128, 128);
      const im = dreamImgCache[rolledNum];
      if (im && im.complete && im.naturalWidth) ctx.drawImage(im, 0, 0, 128, 128);
      else {
        ctx.fillStyle = '#44ff44';
        ctx.beginPath();
        ctx.moveTo(64, 28); ctx.lineTo(104, 64); ctx.lineTo(64, 100); ctx.lineTo(24, 64);
        ctx.closePath(); ctx.fill();
      }
    }
    draw();
    dreamImg(rolledNum, function() { draw(); if (c.userData && c.userData.tex) c.userData.tex.needsUpdate = true; });
    return c;
  }
  function makeReelStripCanvas(first, last) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 1024;
    const ctx = c.getContext('2d');
    const diamondCols = ['#ff4444', '#44ff44', '#4444ff', '#ff44ff', '#ffaa00', '#44ffff', '#ff44ff', '#44ffff'];
    const nums = [];
    for (let s = 0; s < 8; s++) nums.push(first + Math.floor(Math.random() * (last - first + 1)));
    function drawSeg(s) {
      const y0 = s * 128;
      ctx.fillStyle = '#0d0d14'; ctx.fillRect(0, y0, 128, 128);
      const im = dreamImgCache[nums[s]];
      if (im && im.complete && im.naturalWidth) ctx.drawImage(im, 0, y0, 128, 128);
      else {
        ctx.fillStyle = diamondCols[s % 8];
        ctx.beginPath();
        ctx.moveTo(64, y0 + 28); ctx.lineTo(104, y0 + 64); ctx.lineTo(64, y0 + 100); ctx.lineTo(24, y0 + 64);
        ctx.closePath(); ctx.fill();
      }
    }
    for (let s = 0; s < 8; s++) drawSeg(s);
    nums.forEach(function(num, s) {
      dreamImg(num, function() { drawSeg(s); if (c.userData && c.userData.tex) c.userData.tex.needsUpdate = true; });
    });
    return c;
  }
  function buildEncounterMachine(nums, first, last, bodyColor) {
    const g = new THREE.Group();
    const blackMat = new THREE.MeshLambertMaterial({ color: bodyColor || 0x0d0d14 });
    const goldMat = new THREE.MeshLambertMaterial({ color: 0xd4a017 });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x1a0a2e });
    const glowPink = new THREE.MeshBasicMaterial({ color: 0xff4ad8 });
    const glowCyan = new THREE.MeshBasicMaterial({ color: 0x4ad8ff });
    const redMat = new THREE.MeshLambertMaterial({ color: 0xcc2222 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.1, 3.4, 0.9), blackMat);
    body.castShadow = true; g.add(body);
    // Multi-layered body: plinth base + gold side trims, so the cabinet reads as
    // stacked layers instead of one flat box.
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.18, 1.0), darkMat);
    plinth.position.y = -1.79; plinth.castShadow = true; g.add(plinth);
    [-1.57, 1.57].forEach(function(sx) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.4, 0.94), goldMat);
      side.position.set(sx, 0, 0); g.add(side);
    });
    const trimT = new THREE.Mesh(new THREE.BoxGeometry(3.14, 0.08, 0.94), goldMat);
    trimT.position.y = 1.72; g.add(trimT);
    const trimB = new THREE.Mesh(new THREE.BoxGeometry(3.14, 0.08, 0.94), goldMat);
    trimB.position.y = -1.72; g.add(trimB);
    const marq = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.55, 0.95), darkMat);
    marq.position.y = 1.95; marq.castShadow = true; g.add(marq);
    const mc = document.createElement('canvas'); mc.width = 512; mc.height = 128;
    const mctx = mc.getContext('2d');
    mctx.fillStyle = '#2a1a0a'; mctx.fillRect(0, 0, 512, 128);
    mctx.strokeStyle = '#d4a017'; mctx.lineWidth = 6; mctx.strokeRect(6, 6, 500, 116);
    mctx.fillStyle = '#e8b923'; mctx.textAlign = 'center'; mctx.font = 'bold 44px sans-serif';
    mctx.fillText('Deepdreamlings', 256, 52);
    mctx.fillText('Fusion', 256, 102);
    const mtex = new THREE.CanvasTexture(mc);
    const marqFace = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 0.5), new THREE.MeshBasicMaterial({ map: mtex }));
    marqFace.position.set(0, 1.95, 0.48); g.add(marqFace);
    const scrFrame = new THREE.Mesh(new THREE.BoxGeometry(2.95, 1.4, 0.06), goldMat);
    scrFrame.position.set(0, 0.35, 0.47); g.add(scrFrame);
    const scrBg = new THREE.Mesh(new THREE.BoxGeometry(2.85, 1.3, 0.06), darkMat);
    scrBg.position.set(0, 0.35, 0.50); g.add(scrBg);
    for (let li = 0; li < 5; li++) {
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), li % 2 ? glowPink : glowCyan);
      bulb.position.set(-1.2 + li * 0.6, 1.12, 0.52); g.add(bulb);
    }
    g.userData.reels = [];
    const n = nums.length;
    const spacing = 1.0;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * spacing;
      // Multi-layered reel bay: gold plate -> dark recess -> clean drum cylinder ->
      // gold rim ring -> round icon face flush on the drum's front cap. No more
      // square plane floating in front of a bigger dark circle, and no wrapped
      // texture showing several off-center faces at once.
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.86), goldMat);
      plate.position.set(x, 0.35, 0.54); g.add(plate);
      const bay = new THREE.Mesh(new THREE.PlaneGeometry(0.80, 0.80), darkMat);
      bay.position.set(x, 0.35, 0.56); g.add(bay);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.28, 28), darkMat);
      drum.rotation.x = Math.PI / 2; // cylinder axis -> depth, caps facing the camera
      drum.position.set(x, 0.35, 0.71);
      drum.castShadow = true; g.add(drum);
      const rim = new THREE.Mesh(new THREE.RingGeometry(0.345, 0.385, 28), goldMat);
      rim.position.set(x, 0.35, 0.855); g.add(rim);
      // Face: exactly one centered dreamling on a ROUND face, unlit so it stays
      // bright. Same texture swap + strip scroll as before, so spin/stop logic
      // (spinEncounterReels / stopEncounterReel) is untouched.
      const faceCanvas = makeReelFaceCanvas(nums[i]);
      const faceTex = new THREE.CanvasTexture(faceCanvas);
      faceCanvas.userData = { tex: faceTex };
      const stripCanvas = makeReelStripCanvas(first, last);
      const stripTex = new THREE.CanvasTexture(stripCanvas);
      stripTex.wrapT = THREE.RepeatWrapping;
      stripCanvas.userData = { tex: stripTex };
      const face = new THREE.Mesh(new THREE.CircleGeometry(0.345, 28), new THREE.MeshBasicMaterial({ map: faceTex }));
      face.position.set(x, 0.35, 0.862);
      face.userData.scrolling = false;
      face.userData.singleTex = faceTex;
      face.userData.stripTex = stripTex;
      face.userData.rolled = nums[i];
      g.add(face);
      g.userData.reels.push(face);
    }
    const leverBase = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 10), darkMat);
    leverBase.position.set(1.62, 0.35, 0); leverBase.rotation.z = Math.PI / 2; g.add(leverBase);
    const leverMat = new THREE.MeshLambertMaterial({ color: 0xe0e0e0 });
    const leverArm = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.55, 8), leverMat);
    leverArm.position.set(1.70, 0.6, 0); leverArm.rotation.z = -0.35; g.add(leverArm);
    g.userData.leverArm = leverArm;
    const leverBall = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), glowPink);
    leverBall.position.set(1.80, 0.85, 0); g.add(leverBall);
    const doorTrim = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.05, 0.07), goldMat);
    doorTrim.position.set(0, -0.78, 0.47); g.add(doorTrim);
    const door = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.8, 0.06), darkMat);
    door.position.set(0, -1.2, 0.47); g.add(door);
    [-0.3, 0.3].forEach(function(dx) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.3, 0.03), redMat);
      slot.position.set(dx, -1.2, 0.51); g.add(slot);
    });
    g.scale.set(0.78, 0.78, 0.78); // was 0.9: top of marquee was cropped off-screen
    return g;
  }
  function showEncounterMachine(nums, first, last, bodyColor) {
    if (encMachine) {
      // Dispose the spare reel textures too (disposeGroup only sees the assigned map)
      if (encMachine.userData.reels) encMachine.userData.reels.forEach(function(r) {
        if (r.userData.singleTex) r.userData.singleTex.dispose();
        if (r.userData.stripTex) r.userData.stripTex.dispose();
      });
      scene.remove(encMachine); disposeGroup(encMachine); encMachine = null;
    }
    encMachine = buildEncounterMachine(nums, first, last, bodyColor);
    encMachine.visible = true;
    scene.add(encMachine);
  }
  function hideEncounterMachine() {
    if (encMachine) encMachine.visible = false;
  }
  function spinEncounterReels() {
    if (!encMachine) return;
    encMachine.userData.reels.forEach(function(reel) {
      reel.userData.scrolling = true;
      reel.material.map = reel.userData.stripTex;
      reel.material.needsUpdate = true;
    });
  }
  function stopEncounterReel(i) {
    if (!encMachine || !encMachine.userData.reels[i]) return;
    const reel = encMachine.userData.reels[i];
    reel.userData.scrolling = false;
    // Back to the single rolled dreamling: perfectly centered by construction,
    // no rotation-alignment guesswork like the old wrapped drums
    reel.material.map = reel.userData.singleTex;
    reel.material.needsUpdate = true;
  }

  return {
    init: init,
    resize: resize,
    buildWorld: buildWorld,
    render: render,
    animate: animate,
    setCharacter: setCharacter,
    setCharacterTexture: setCharacterTexture,
    setCompanion: setCompanion,
    setNPC: setNPC,
    floaterCount: function() { return floaterSprites.length; },
    getScene: function() { return scene; },
    getCamera: function() { return camera; },
    isInitialized: function() { return initialized; },
    buildGenerator: buildGenerator,
    clearGenerator: clearGenerator,
    addBuilding: addBuilding,
    setFloaters: setFloaters,
    // Deepdream skin: apply a video element as the texture on water slot machine bodies
    setWaterSlotVideo: function(videoEl) {
      if (!waterSlotBodyMat || !videoEl) return;
      try {
        const vtex = new THREE.VideoTexture(videoEl);
        vtex.minFilter = THREE.LinearFilter;
        vtex.magFilter = THREE.LinearFilter;
        waterSlotBodyMat.map = vtex;
        waterSlotBodyMat.color.setHex(0xffffff);
        waterSlotBodyMat.needsUpdate = true;
      } catch(e) {}
    },
    // Slot reel controls (sync with 2D encounter slots)
    spinWaterSlots: function() {
      if (!worldGroup || !worldGroup.userData.waterSlots) return;
      worldGroup.userData.waterSlots.forEach(function(m) {
        if (m.userData.reels) m.userData.reels.forEach(function(reel) { reel.userData.spinning = true; });
      });
    },
    stopWaterSlot: function(reelIdx) {
      if (!worldGroup || !worldGroup.userData.waterSlots) return;
      worldGroup.userData.waterSlots.forEach(function(m) {
        if (m.userData.reels && m.userData.reels[reelIdx]) {
          const reel = m.userData.reels[reelIdx];
          reel.userData.spinning = false;
          // Target: next full symbol alignment (multiples of 2π/6)
          const step = (Math.PI * 2) / 6;
          reel.userData.targetAngle = Math.ceil(reel.userData.spinAngle / step) * step + step * 2;
        }
      });
    },
    stopAllWaterSlots: function() {
      for (let i = 0; i < 3; i++) this.stopWaterSlot(i);
    },
    getWoodsSlotTiles: function() { return woodsSlotTiles.slice(); },
    showEncounterMachine: showEncounterMachine,
    hideEncounterMachine: hideEncounterMachine,
    spinEncounterReels: spinEncounterReels,
    stopEncounterReel: stopEncounterReel,
  };
})();
