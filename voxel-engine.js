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
    treeHeight: 1.6,
    waterHeight: 0.22,
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
    if (/tree/i.test(n)) return DIORAMA.treeHeight;
    if (isSolid) return DIORAMA.solidHeight;
    return DIORAMA.groundHeight;
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
    // Slight bevel feel via vertex colors? Keep simple: flat boxes with texture

    for (const name in byTile) {
      const list = byTile[name];
      const tex = getTileTexture(name);
      const isWater = isWaterTile(name);

      // Material: textured top, slightly darker sides for voxel depth
      const mat = new THREE.MeshLambertMaterial({
        map: tex,
        transparent: isWater,
        opacity: isWater ? 0.85 : 1.0,
      });

      const im = new THREE.InstancedMesh(boxGeo, mat, list.length);
      im.castShadow = !isWater;
      im.receiveShadow = true;

      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();

      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const h = tileHeight(name, t.solid);
        // x = col, z = row, y = height/2 (sitting on base)
        pos.set(t.c, h / 2, t.r);
        scl.set(1, h, 1);
        // Slight random rotation for organic feel? No — keep grid aligned for gameplay clarity
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
        m4.compose(pos, q, scl);
        im.setMatrixAt(i, m4);
      }
      im.instanceMatrix.needsUpdate = true;
      worldGroup.add(im);
      tileMeshes[name] = im;
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

  // Diorama camera: follows player, angled like a physical model
  let camTarget = { x: 0, z: 0 };
  function updateCamera(px, pz, snap) {
    const tx = px, tz = pz;
    if (snap) {
      camTarget.x = tx; camTarget.z = tz;
    } else {
      // Smooth follow
      camTarget.x += (tx - camTarget.x) * 0.08;
      camTarget.z += (tz - camTarget.z) * 0.08;
    }
    // Diorama angle: closer, more intimate — like holding the model
    camera.position.set(
      camTarget.x + 4.5,
      7.5,
      camTarget.z + 6.5
    );
    camera.lookAt(camTarget.x, 0.4, camTarget.z);
  }

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

  // Render one frame
  function render(px, pz) {
    if (!initialized) return;
    updateCamera(px, pz, false);
    renderer.render(scene, camera);
  }

  // ===== 3D GENERATOR BUILDING (voxel diorama version) =====
  // Builds a small voxel structure at the generator footprint
  function buildGenerator(gx, gy, gw, gh) {
    clearGenerator();
    genGroup = new THREE.Group();
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x3d2670 });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x140a24 });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x8affea });
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);

    // Walls: voxel boxes around the footprint
    for (let cx = 0; cx < gw; cx++) {
      for (let cz = 0; cz < gh; cz++) {
        const wall = new THREE.Mesh(boxGeo, wallMat);
        wall.position.set(gx + cx + 0.5, 0.65, gy + cz + 0.5);
        wall.scale.set(0.96, 1.3, 0.96);
        wall.castShadow = true;
        wall.receiveShadow = true;
        genGroup.add(wall);
      }
    }
    // Roof: slightly larger flat voxel slab
    const roof = new THREE.Mesh(boxGeo, roofMat);
    roof.position.set(gx + gw / 2, 1.45, gy + gh / 2);
    roof.scale.set(gw + 0.3, 0.25, gh + 0.3);
    roof.castShadow = true;
    genGroup.add(roof);
    // Glowing sign orb on top (the dreaming eye)
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xc9a0ff })
    );
    orb.position.set(gx + gw / 2, 1.9, gy + gh / 2);
    genGroup.add(orb);
    genGroup.userData.orb = orb;
    // Door glow strip
    const door = new THREE.Mesh(boxGeo, glowMat);
    door.position.set(gx + gw / 2, 0.35, gy + gh + 0.02);
    door.scale.set(0.5, 0.7, 0.06);
    genGroup.add(door);

    worldGroup.add(genGroup);
  }

  function clearGenerator() {
    if (genGroup) {
      worldGroup.remove(genGroup);
      genGroup = null;
    }
  }

  // ===== 3D DREAM FLOATERS (billboard sprites in voxel space) =====
  function setFloaters(list) {
    // Remove old
    for (const s of floaterSprites) scene.remove(s);
    floaterSprites = [];
    for (const f of list) {
      if (!f.imgs || !f.imgs.length) continue;
      const tex = new THREE.Texture(f.imgs[0]);
      tex.needsUpdate = true;
      tex.magFilter = THREE.NearestFilter;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.9 });
      const spr = new THREE.Sprite(mat);
      spr.scale.set(1.2, 1.2, 1);
      spr.position.set(f.hx + 0.5, 1.5, f.hy + 0.5);
      spr.userData.floater = f;
      scene.add(spr);
      floaterSprites.push(spr);
    }
  }

  function animateFloaters(time) {
    for (const spr of floaterSprites) {
      const f = spr.userData.floater;
      if (!f) continue;
      const wx = f.hx + Math.sin(time * f.sp + f.ph) * f.rg;
      const wz = f.hy + Math.cos(time * f.sp * 0.77 + f.ph * 1.3) * f.rg * 0.7;
      const bob = Math.sin(time / 600 + f.ph) * 0.15;
      spr.position.set(wx + 0.5, 1.5 + bob, wz + 0.5);
      // Cycle dream thumbnails
      if (f.imgs && f.imgs.length > 1) {
        const idx = Math.floor(time / 240) % f.imgs.length;
        const tex = new THREE.Texture(f.imgs[idx]);
        tex.needsUpdate = true;
        tex.magFilter = THREE.NearestFilter;
        spr.material.map = tex;
        spr.material.needsUpdate = true;
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
    getScene: function() { return scene; },
    getCamera: function() { return camera; },
    isInitialized: function() { return initialized; },
    buildGenerator: buildGenerator,
    clearGenerator: clearGenerator,
    setFloaters: setFloaters,
  };
})();
