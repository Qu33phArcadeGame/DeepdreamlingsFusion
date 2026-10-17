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

  // Determine voxel height by tile type
  function tileHeight(tileName, isSolid) {
    const n = (tileName || "").toLowerCase();
    if (/water/i.test(n)) return DIORAMA.waterHeight;
    if (/path|dirt|road/i.test(n)) return DIORAMA.pathHeight;  // sunken paths
    if (/tree/i.test(n)) return -1;  // trees get custom stacked geometry (see buildWorld)
    if (isSolid) return DIORAMA.solidHeight;
    return DIORAMA.groundHeight;
  }

  // Check if tile is a tree/prop (gets stacked trunk+canopy, stood up in 3D)
  function isTreeTile(name) {
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
  function buildWorld(M) {
    mapData = M;
    // Clear old world
    while (worldGroup.children.length > 0) {
      const c = worldGroup.children[0];
      worldGroup.remove(c);
      if (c.geometry) c.geometry.dispose();
    }
    tileMeshes = {};
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
      const treeList = [], flatList = [];
      for (const t of list) {
        // Named tree, or isolated solid prop (no solid neighbors) → stand it up
        if (namedTree || isIsolatedSolid(M, t.c, t.r)) treeList.push(t);
        else flatList.push(t);
      }
      for (const t of treeList) treePositions.push({ c: t.c, r: t.r, texName: name });
      if (!flatList.length) continue;
      const tex = getTileTexture(name);
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
      const TRUNK_H = 1.3;
      for (let i = 0; i < treePositions.length; i++) {
        const t = treePositions[i];
        pos.set(t.c, TRUNK_H / 2, t.r); scl.set(0.38, TRUNK_H, 0.38);
        m4.compose(pos, q, scl); trunkIM.setMatrixAt(i, m4);
      }
      trunkIM.instanceMatrix.needsUpdate = true;
      worldGroup.add(trunkIM);
      // Canopy: 3 shrinking layers per tree, grouped by tile texture
      const byTex = {};
      for (const t of treePositions) { (byTex[t.texName] = byTex[t.texName] || []).push(t); }
      // [width, height, yBaseOffset] for each layer, from bottom to top
      const LAYERS = [
        [1.7, 0.8, TRUNK_H - 0.25],
        [1.25, 0.7, TRUNK_H + 0.35],
        [0.75, 0.6, TRUNK_H + 0.85],
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

    // Soft ground plane far below for shadow catching (diorama sits in space)
    // Actually skip — fog handles the void

    // Position camera default
    updateCamera((cols - 1) / 2, (rows - 1) / 2, true);
  }

  // Diorama camera: manual orbit via the blue-button joystick.
  // Auto-orbit is OFF (too crazy) — the player aims the camera.
  let camTarget = { x: 0, z: 0 };
  let camOrbit = 0.6;          // current orbit angle (radians), joystick-controlled
  function updateCamera(px, pz, snap) {
    const tx = px, tz = pz;
    if (snap) { camTarget.x = tx; camTarget.z = tz; }
    else {
      camTarget.x += (tx - camTarget.x) * 0.08;
      camTarget.z += (tz - camTarget.z) * 0.08;
    }
    // Camera sits out from the player along the orbit direction, looking in
    const dist = 8.0, height = 6.5;
    camera.position.set(
      camTarget.x + Math.sin(camOrbit) * dist,
      height,
      camTarget.z + Math.cos(camOrbit) * dist
    );
    camera.lookAt(camTarget.x, 0.4, camTarget.z);
  }
  // Joystick nudges the orbit angle (radians per call, smoothed by caller)
  function orbitCamera(dTheta) { camOrbit += dTheta; }

  // Character sprite (billboard, preserves 2D art)
  function setCharacter(textureUrl, x, z, bounceY) {
    if (!charSprite) {
      const tex = new THREE.TextureLoader().load(resolveUrl(textureUrl));
      tex.magFilter = THREE.NearestFilter;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
      charSprite = new THREE.Sprite(mat);
      charSprite.scale.set(1.1, 1.5, 1);
      scene.add(charSprite);
    }
    charSprite.position.set(x, 0.9 + (bounceY || 0), z);
  }

  function setCharacterTexture(url) {
    url = resolveUrl(url);
    if (!charTextures[url]) {
      const tex = new THREE.TextureLoader().load(url);
      tex.magFilter = THREE.NearestFilter;
      charTextures[url] = tex;
    }
    if (charSprite) {
      charSprite.material.map = charTextures[url];
      charSprite.material.needsUpdate = true;
    }
  }

  // Companion dreamling: animated billboard sprite that orbits/bobs in 3D
  let companionTexCache = {};
  function setCompanion(textureUrl, x, z, time) {
    if (!textureUrl) {
      if (companionSprite) { scene.remove(companionSprite); companionSprite = null; }
      return;
    }
    const rurl = resolveUrl(textureUrl);
    if (!companionSprite) {
      const tex = new THREE.TextureLoader().load(rurl);
      tex.magFilter = THREE.NearestFilter;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
      companionSprite = new THREE.Sprite(mat);
      companionSprite.scale.set(1.0, 1.0, 1);
      scene.add(companionSprite);
      companionTexCache[rurl] = tex;
    } else if (!companionTexCache[rurl]) {
      const tex = new THREE.TextureLoader().load(rurl);
      tex.magFilter = THREE.NearestFilter;
      companionTexCache[rurl] = tex;
      companionSprite.material.map = tex;
      companionSprite.material.needsUpdate = true;
    } else if (companionSprite.material.map !== companionTexCache[rurl]) {
      companionSprite.material.map = companionTexCache[rurl];
      companionSprite.material.needsUpdate = true;
    }
    // Bobbing animation (dreamlings float)
    const bob = Math.sin(time / 450) * 0.18;
    const sway = Math.sin(time / 700) * 0.12;
    companionSprite.position.set(x + sway, 1.1 + bob, z);
    // Gentle pulsing scale (breathing)
    const pulse = 1 + Math.sin(time / 600) * 0.06;
    companionSprite.scale.set(pulse, pulse, 1);
  }

  // Render one frame
  function render(px, pz) {
    if (!initialized) return;
    updateCamera(px, pz, false);
    renderer.render(scene, camera);
  }

  // ===== 3D GENERATOR BUILDING (voxel diorama version) =====
  // Builds a proper 3D structure: tall walls, roof with overhang, glowing details
  function buildGenerator(gx, gy, gw, gh) {
    clearGenerator();
    genGroup = new THREE.Group();
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x3d2670 });
    const trimMat = new THREE.MeshLambertMaterial({ color: 0x6a4a9a });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x1a0f2e });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x8affea });
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const WALL_H = 2.2;

    // Walls: tall voxel boxes forming the building body
    for (let cx = 0; cx < gw; cx++) {
      for (let cz = 0; cz < gh; cz++) {
        const wall = new THREE.Mesh(boxGeo, wallMat);
        wall.position.set(gx + cx + 0.5, WALL_H / 2, gy + cz + 0.5);
        wall.scale.set(0.96, WALL_H, 0.96);
        wall.castShadow = true;
        wall.receiveShadow = true;
        genGroup.add(wall);
      }
    }
    // Trim: decorative band at top of walls
    const trim = new THREE.Mesh(boxGeo, trimMat);
    trim.position.set(gx + gw / 2, WALL_H + 0.08, gy + gh / 2);
    trim.scale.set(gw + 0.15, 0.16, gh + 0.15);
    trim.castShadow = true;
    genGroup.add(trim);
    // Roof: thick slab with overhang
    const roof = new THREE.Mesh(boxGeo, roofMat);
    roof.position.set(gx + gw / 2, WALL_H + 0.32, gy + gh / 2);
    roof.scale.set(gw + 0.5, 0.35, gh + 0.5);
    roof.castShadow = true;
    genGroup.add(roof);
    // Roof peak: smaller raised block in center
    const peak = new THREE.Mesh(boxGeo, trimMat);
    peak.position.set(gx + gw / 2, WALL_H + 0.62, gy + gh / 2);
    peak.scale.set(gw * 0.5, 0.25, gh * 0.5);
    peak.castShadow = true;
    genGroup.add(peak);
    // Glowing sign orb on top (the dreaming eye)
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xc9a0ff })
    );
    orb.position.set(gx + gw / 2, WALL_H + 1.0, gy + gh / 2);
    genGroup.add(orb);
    genGroup.userData.orb = orb;
    // Door: glowing entrance on front face
    const door = new THREE.Mesh(boxGeo, glowMat);
    door.position.set(gx + gw / 2, 0.55, gy + gh + 0.03);
    door.scale.set(0.6, 1.1, 0.08);
    genGroup.add(door);
    // Windows: glowing strips on sides
    for (let s = 0; s < 2; s++) {
      const win = new THREE.Mesh(boxGeo, glowMat);
      const wx = s ? gx + gw + 0.02 : gx - 0.02;
      win.position.set(wx, WALL_H * 0.6, gy + gh / 2);
      win.scale.set(0.06, 0.5, 0.7);
      genGroup.add(win);
    }

    worldGroup.add(genGroup);
  }

  function clearGenerator() {
    if (genGroup) {
      worldGroup.remove(genGroup);
      genGroup = null;
    }
  }

  // ===== 3D DREAM FLOATERS (billboard sprites in voxel space) =====
  // Each floater composites its dreamling silhouette (dreamlingP<num>.png) with the
  // card's dream thumbnail cycling INSIDE the silhouette — the 2D look, as a 3D billboard.
  // Thumbnails load async, so textures start blank and refresh on each image load.
  const floaterSilhouettes = {};  // num -> HTMLImageElement
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
    cx.clearRect(0, 0, S, S);
    const sil = getSilhouette(f.num);
    const texes = spr.userData.texes;
    const thumb = (texes && texes.length) ? texes[Math.floor(performance.now() / 240) % texes.length] : null;
    if (sil && sil.complete && sil.naturalWidth) {
      cx.drawImage(sil, 0, 0, S, S);
      // Clip the dream thumbnail inside the silhouette
      if (thumb && thumb.image && thumb.image.complete && thumb.image.naturalWidth) {
        cx.save();
        cx.globalCompositeOperation = "source-atop";
        cx.drawImage(thumb.image, 0, 0, S, S);
        cx.restore();
      }
    } else if (thumb && thumb.image) {
      // Silhouette not ready yet — show thumbnail alone rather than blank
      if (thumb.image.complete && thumb.image.naturalWidth) cx.drawImage(thumb.image, 0, 0, S, S);
    }
    spr.userData.ctex.needsUpdate = true;
  }
  function refreshFloaterTextures() {
    for (const spr of floaterSprites) compositeFloater(spr);
  }
  function setFloaters(list) {
    for (const s of floaterSprites) scene.remove(s);
    floaterSprites = [];
    for (const f of list) {
      if (!f.imgs || !f.imgs.length) continue;
      // Wrap each thumbnail image; refresh composite when it loads
      const texes = f.imgs.map(function(im){
        const rec = { image: im };
        const old = im.onload;
        im.onload = function(){ if (old) old(); refreshFloaterTextures(); };
        // If already loaded (cached), trigger a refresh soon
        if (im.complete && im.naturalWidth) setTimeout(refreshFloaterTextures, 0);
        return rec;
      });
      const cv = document.createElement("canvas");
      cv.width = cv.height = 64;
      const ctex = new THREE.CanvasTexture(cv);
      ctex.magFilter = THREE.NearestFilter;
      const mat = new THREE.SpriteMaterial({ map: ctex, transparent: true, opacity: 0.95 });
      const spr = new THREE.Sprite(mat);
      spr.scale.set(1.3, 1.3, 1);
      spr.position.set(f.hx + 0.5, 1.6, f.hy + 0.5);
      spr.userData.floater = f;
      spr.userData.texes = texes;
      spr.userData.canvas = cv;
      spr.userData.ctex = ctex;
      spr.userData.thumbIdx = -1;
      getSilhouette(f.num);  // kick off silhouette load
      compositeFloater(spr);
      scene.add(spr);
      floaterSprites.push(spr);
    }
  }

  function animateFloaters(time) {
    for (const spr of floaterSprites) {
      const f = spr.userData.floater;
      if (!f) continue;
      // Wander around their home tile
      const wx = f.hx + Math.sin(time * f.sp + f.ph) * f.rg;
      const wz = f.hy + Math.cos(time * f.sp * 0.77 + f.ph * 1.3) * f.rg * 0.7;
      const bob = Math.sin(time / 600 + f.ph) * 0.18;
      spr.position.set(wx + 0.5, 1.6 + bob, wz + 0.5);
      // Re-composite when the thumbnail cycles (the inner card animation)
      const texes = spr.userData.texes;
      if (texes && texes.length > 1) {
        const idx = Math.floor(time / 240) % texes.length;
        if (idx !== spr.userData.thumbIdx) {
          spr.userData.thumbIdx = idx;
          compositeFloater(spr);
        }
      }
    }
    // Pulse the generator orb
    if (genGroup && genGroup.userData.orb) {
      const s = 1 + Math.sin(time / 380) * 0.15;
      genGroup.userData.orb.scale.set(s, s, s);
    }
  }

  // Animate water (subtle y bob on water instances)
  // Called per frame with time
  function animate(time) {
    animateFloaters(time);
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
    orbitCamera: orbitCamera,
    getScene: function() { return scene; },
    getCamera: function() { return camera; },
    isInitialized: function() { return initialized; },
    buildGenerator: buildGenerator,
    clearGenerator: clearGenerator,
    setFloaters: setFloaters,
  };
})();
