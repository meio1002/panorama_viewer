import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const container = document.getElementById("viewer");
const fileInput = document.getElementById("fileInput");
const resetBtn = document.getElementById("resetBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");

let scene;
let camera;
let renderer;
let controls;
let sphere;
let currentTexture;

init();
loadPanorama("./assets/panorama.jpeg");
animate();

function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );

  // 完全に原点だと操作開始時に不安定になる場合があるため、わずかに前へ置く
  camera.position.set(0, 0, 0.1);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance"
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 0.1;
  controls.maxDistance = 0.1;
  controls.rotateSpeed = -0.35;

  // ズームはカメラのFOVで制御
  controls.enableZoom = false;
  renderer.domElement.addEventListener("wheel", onMouseWheel, { passive: false });

  window.addEventListener("resize", onResize);
  fileInput.addEventListener("change", onFileSelected);
  resetBtn.addEventListener("click", resetView);
  fullscreenBtn.addEventListener("click", toggleFullscreen);
}

function loadPanorama(url) {
  const loader = new THREE.TextureLoader();

  loader.load(
    url,
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;

      setPanoramaTexture(texture);
    },
    undefined,
    (error) => {
      console.error("パノラマ画像の読み込みに失敗しました:", error);
      alert("画像の読み込みに失敗しました。");
    }
  );
}

function setPanoramaTexture(texture) {
  if (currentTexture) {
    currentTexture.dispose();
  }

  currentTexture = texture;

  if (!sphere) {
    const geometry = new THREE.SphereGeometry(500, 128, 96);

    // 球体の内側から見るためにX方向を反転
    geometry.scale(-1, 1, 1);

    const material = new THREE.MeshBasicMaterial({
      map: currentTexture
    });

    sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);
  } else {
    sphere.material.map = currentTexture;
    sphere.material.needsUpdate = true;
  }

  resetView();
}

function onFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();

  image.onload = () => {
    const ratio = image.width / image.height;

    // 360° equirectangular画像は通常2:1。少し余裕を持って判定。
    if (ratio < 1.8 || ratio > 2.2) {
      const ok = confirm(
        `この画像は ${image.width}×${image.height} で、2:1比率ではありません。\n` +
        "表示はできますが、歪む可能性があります。続行しますか？"
      );

      if (!ok) {
        URL.revokeObjectURL(objectUrl);
        fileInput.value = "";
        return;
      }
    }

    loadPanorama(objectUrl);
  };

  image.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    alert("画像を読み込めませんでした。");
  };

  image.src = objectUrl;
}

function onMouseWheel(event) {
  event.preventDefault();

  const delta = Math.sign(event.deltaY);
  camera.fov = THREE.MathUtils.clamp(camera.fov + delta * 3, 35, 100);
  camera.updateProjectionMatrix();
}

function resetView() {
  camera.fov = 75;
  camera.updateProjectionMatrix();

  camera.position.set(0, 0, 0.1);
  controls.target.set(0, 0, 0);
  controls.update();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);

  controls.update();
  renderer.render(scene, camera);
}
