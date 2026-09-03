import { Archive } from './vendor/libarchive/libarchive.js';

Archive.init({
  workerUrl: 'js/vendor/libarchive/worker-bundle.js'
});

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i;
const COMICS_DIR = 'comics';
const PROGRESS_KEY = 'comicsLibrary.progress.v1';

// Las portadas se muestran pequeñas en la rejilla, no hace falta guardarlas ni
// servirlas a la resolucion original de la pagina del comic (puede ser >2000px).
// Las redimensionamos a un ancho/alto maximo y las recomprimimos como JPEG antes
// de pintarlas y antes de subirlas al servidor, para que carguen rapido y no
// llenen la carpeta de cache.
const COVER_MAX_WIDTH = 500;
const COVER_MAX_HEIGHT = 750;
const COVER_JPEG_QUALITY = 0.82;

const gridEl = document.getElementById('grid');
const statusEl = document.getElementById('status');
const counterEl = document.getElementById('counter');
const searchInput = document.getElementById('searchInput');
const categoryNavEl = document.getElementById('categoryNav');
const resetProgressBtn = document.getElementById('resetProgressBtn');

const categoryBannerEl = document.getElementById('categoryBanner');
const categoryBannerBgEl = document.getElementById('categoryBannerBg');
const categoryBannerTitleEl = document.getElementById('categoryBannerTitle');
const categoryBannerYearsEl = document.getElementById('categoryBannerYears');
const categoryBannerSynopsisEl = document.getElementById('categoryBannerSynopsis');

const readerEl = document.getElementById('reader');
const readerTitleEl = document.getElementById('readerTitle');
const readerPageInfoEl = document.getElementById('readerPageInfo');
const readerImageEl = document.getElementById('readerImage');
const readerLoadingEl = document.getElementById('readerLoading');
const readerPrevBtn = document.getElementById('readerPrev');
const readerNextBtn = document.getElementById('readerNext');
const readerCloseBtn = document.getElementById('readerClose');

let allCategories = [];   // [{ name, comics: [...] }]
let allComicsFlat = [];   // todos los comics en un solo array, para el buscador y el filtro
let selectedCategory = 'Todos';
let categoryInfoMap = {}; // { [nombreCategoria]: { years, synopsis, image } }, ver data/category-info.json

/* ---------------- Banner de categoria (años / imagen de fondo / sinopsis) ---------------- */
// La info (años, sinopsis) se rellena a mano en data/category-info.json.
// La imagen de fondo tambien es manual: se coloca en images/categories/, con el
// mismo nombre que la categoria (ej. "Marvel" -> images/categories/Marvel.jpg),
// salvo que en el JSON se indique otra ruta con la propiedad "image".
const CATEGORY_IMAGES_DIR = 'images/categories';

async function loadCategoryInfo() {
  try {
    const res = await fetch('data/category-info.json');
    if (!res.ok) return;
    categoryInfoMap = await res.json();
  } catch (e) {
    categoryInfoMap = {}; // si no existe el fichero o esta mal formado, seguimos sin banner
  }
}

function defaultCategoryImage(name) {
  return `${CATEGORY_IMAGES_DIR}/${encodeURIComponent(name)}.jpg`;
}

function renderCategoryBanner(name) {
  const info = categoryInfoMap[name];

  if (name === 'Todos' || !info) {
    categoryBannerEl.classList.add('hidden');
    categoryBannerBgEl.style.backgroundImage = '';
    return;
  }

  categoryBannerEl.classList.remove('hidden');
  categoryBannerTitleEl.textContent = name;
  categoryBannerYearsEl.textContent = info.years || '';
  categoryBannerYearsEl.style.display = info.years ? '' : 'none';
  categoryBannerSynopsisEl.textContent = info.synopsis || '';

  const imageUrl = info.image || defaultCategoryImage(name);
  // Comprobamos que la imagen exista antes de pintarla como fondo, para no
  // dejar un hueco roto si todavia no se ha descargado/colocado el archivo.
  const probe = new Image();
  probe.onload = () => { categoryBannerBgEl.style.backgroundImage = `url("${imageUrl}")`; };
  probe.onerror = () => { categoryBannerBgEl.style.backgroundImage = ''; };
  probe.src = imageUrl;
}

/* ---------------- Progreso de lectura (persistente, localStorage) ---------------- */
// Se guarda por comic (categoria + ruta) la ultima pagina vista, el total de paginas
// y si se llego al final, para poder retomar la lectura donde se dejo la proxima vez.

let progressMap = loadProgressMap();

function loadProgressMap() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveProgressMap() {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progressMap));
  } catch (e) { /* localStorage lleno o no disponible: no rompemos la app por esto */ }
}

function comicKey(comic) {
  return `${comic.category}::${comic.path}`;
}

function getProgress(comic) {
  return progressMap[comicKey(comic)] || null;
}

function setProgress(comic, pageIndex, totalPages) {
  progressMap[comicKey(comic)] = {
    page: pageIndex,
    total: totalPages,
    finished: pageIndex >= totalPages - 1,
    updatedAt: Date.now(),
  };
  saveProgressMap();
}

/* ---------------- Utilidades de archivo ---------------- */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function sortEntries(entries) {
  return entries.slice().sort((a, b) => collator.compare(a.path + a.file.name, b.path + b.file.name));
}

function isImageEntry(entry) {
  return entry.file && entry.file.name && IMAGE_EXT.test(entry.file.name);
}

// Cierra el worker interno de una instancia Archive una vez hemos terminado con ella.
// La libreria no expone un metodo publico "close" para uso parcial (solo tras extractFiles),
// asi que liberamos el worker manualmente para no dejar workers colgados por cada comic abierto.
function closeArchive(archive) {
  try {
    if (archive && archive._worker) archive._worker.terminate();
  } catch (e) { /* noop */ }
}

function comicUrl(comic) {
  // comic.path puede llevar subcarpeta (ej. "Marvel/0001 - Titulo.cbr");
  // codificamos cada tramo por separado para no escapar las barras "/"
  const encodedPath = comic.path.split('/').map(encodeURIComponent).join('/');
  return `${COMICS_DIR}/${encodedPath}`;
}

async function fetchComicBlob(comic) {
  const res = await fetch(comicUrl(comic));
  if (!res.ok) throw new Error(`No se pudo descargar ${comic.path} (${res.status})`);
  return res.blob();
}

async function getSortedImageEntries(blob) {
  const archive = await Archive.open(blob);
  const files = await archive.getFilesArray();
  const images = sortEntries(files.filter(isImageEntry));
  return { archive, images };
}

// Redimensiona una imagen (blob) a un maximo de ancho/alto manteniendo el
// aspect ratio y la recodifica como JPEG. Si la imagen ya es mas pequena que
// el maximo, no la reescala (solo la recomprime si hace falta).
async function resizeImageBlob(blob, maxWidth, maxHeight, quality) {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);

    const resized = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('No se pudo generar la miniatura'))),
        'image/jpeg',
        quality
      );
    });
    return resized;
  } finally {
    bitmap.close();
  }
}

/* ---------------- Listado / portadas ---------------- */

async function loadComicsList() {
  statusEl.textContent = 'Cargando listado de comics...';
  statusEl.className = 'status';

  let data;
  try {
    const res = await fetch('api/list.php');
    data = await res.json();
  } catch (e) {
    statusEl.textContent = 'Error al conectar con api/list.php. Revisa que estes usando XAMPP (http://localhost/...).';
    statusEl.className = 'status error';
    return;
  }

  if (data.error) {
    statusEl.textContent = data.message || 'Error al listar los comics.';
    statusEl.className = 'status error';
    return;
  }

  // Adjuntamos la categoria a cada comic para poder usarla como clave de progreso y en los filtros
  allCategories = data.categories.map((cat) => ({
    name: cat.name,
    comics: cat.comics.map((c) => ({ ...c, category: cat.name })),
  }));
  allComicsFlat = allCategories.flatMap((cat) => cat.comics);

  // Si la URL trae una coleccion en el hash (ej. #Marvel) y existe, la seleccionamos
  // directamente al cargar, para que los enlaces a una coleccion funcionen solos.
  const hashCategory = hashToCategory(location.hash);
  if (hashCategory && allCategories.some((c) => c.name === hashCategory)) {
    selectedCategory = hashCategory;
  }

  statusEl.textContent = '';
  buildCategoryNav();
  renderCategoryBanner(selectedCategory);
  applyFilters();
}

// Convierte el nombre de una coleccion en el valor que va tras el "#" en la URL
function categoryToHash(name) {
  return encodeURIComponent(name);
}

// Extrae el nombre de coleccion desde el hash actual de la URL (null si no hay o es invalido)
function hashToCategory(hash) {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    return null;
  }
}

// Selecciona una categoria: actualiza el estado, los botones activos, el listado
// y (opcionalmente) la URL, para que el enlace refleje siempre la coleccion vista.
function selectCategory(name, { updateHash = true } = {}) {
  selectedCategory = name;
  categoryNavEl.querySelectorAll('.category-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.category === name);
  });

  if (updateHash) {
    if (name === 'Todos') {
      history.pushState(null, '', location.pathname + location.search);
    } else {
      location.hash = categoryToHash(name);
    }
  }

  renderCategoryBanner(name);
  applyFilters();
}

function buildCategoryNav() {
  categoryNavEl.innerHTML = '';

  const buttons = [{ name: 'Todos', count: allComicsFlat.length }, ...allCategories.map((c) => ({ name: c.name, count: c.comics.length }))];

  buttons.forEach(({ name, count }) => {
    const btn = document.createElement('button');
    btn.className = 'category-btn';
    btn.textContent = `${name} (${count})`;
    btn.dataset.category = name;
    if (name === selectedCategory) btn.classList.add('active');
    btn.addEventListener('click', () => selectCategory(name));
    categoryNavEl.appendChild(btn);
  });
}

// Si el usuario navega con atras/adelante del navegador, el hash cambia solo:
// sincronizamos la coleccion seleccionada sin volver a tocar la URL.
window.addEventListener('hashchange', () => {
  const name = hashToCategory(location.hash);
  const valid = name && (name === 'Todos' || allCategories.some((c) => c.name === name));
  selectCategory(valid ? name : 'Todos', { updateHash: false });
});

// Aplica a la vez el filtro de categoria seleccionada y el texto del buscador
function applyFilters() {
  const q = searchInput.value.trim().toLowerCase();

  let comics = selectedCategory === 'Todos'
    ? allComicsFlat
    : allComicsFlat.filter((c) => c.category === selectedCategory);

  if (q) {
    comics = comics.filter((c) => {
      const num = c.number !== null ? String(c.number).padStart(3, '0') : '';
      return c.title.toLowerCase().includes(q) || num.includes(q) ||
             c.file.toLowerCase().includes(q) || c.category.toLowerCase().includes(q);
    });
  }

  counterEl.textContent = q || selectedCategory !== 'Todos'
    ? `${comics.length} / ${allComicsFlat.length} comics`
    : `${comics.length} comics`;

  renderGrid(comics);
}

function renderGrid(comics) {
  gridEl.innerHTML = '';

  if (comics.length === 0) {
    statusEl.textContent = 'No se ha encontrado ningun comic con ese filtro.';
    statusEl.className = 'status';
    return;
  }
  statusEl.textContent = '';

  const fragment = document.createDocumentFragment();
  comics.forEach((comic) => fragment.appendChild(buildCard(comic)));
  gridEl.appendChild(fragment);

  observeCovers();
}

function buildCard(comic) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.file = comic.path;

  const coverWrap = document.createElement('div');
  coverWrap.className = 'cover-wrap';

  let placeholder = null;
  if (comic.coverUrl) {
    // Portada ya cacheada en el servidor: se pinta directamente, sin extraer nada
    const img = document.createElement('img');
    img.src = comic.coverUrl;
    img.alt = comic.title;
    img.loading = 'lazy';
    coverWrap.appendChild(img);
  } else {
    placeholder = document.createElement('div');
    placeholder.className = 'cover-placeholder';
    placeholder.textContent = '📕';
    coverWrap.appendChild(placeholder);
  }

  if (comic.number !== null) {
    const badge = document.createElement('span');
    badge.className = 'badge-number';
    badge.textContent = String(comic.number).padStart(3, '0');
    coverWrap.appendChild(badge);
  }

  applyProgressBadge(coverWrap, comic);

  const info = document.createElement('div');
  info.className = 'card-info';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = comic.title;
  info.appendChild(title);

  card.appendChild(coverWrap);
  card.appendChild(info);

  card._comic = comic;
  card._coverWrap = coverWrap;
  card._placeholder = placeholder;

  card.addEventListener('click', () => openReader(comic));

  return card;
}

// Pinta, sobre la portada, el estado de lectura guardado (si lo hay)
function applyProgressBadge(coverWrap, comic) {
  const progress = getProgress(comic);
  if (!progress) return;

  if (progress.finished) {
    const finished = document.createElement('span');
    finished.className = 'badge-finished';
    finished.textContent = '✓ Leido';
    coverWrap.appendChild(finished);
  } else {
    const bar = document.createElement('div');
    bar.className = 'badge-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'badge-progress-fill';
    const pct = Math.round(((progress.page + 1) / progress.total) * 100);
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    coverWrap.appendChild(bar);

    const label = document.createElement('span');
    label.className = 'badge-progress-label';
    label.textContent = `Pag. ${progress.page + 1}/${progress.total}`;
    coverWrap.appendChild(label);
  }
}

// Carga perezosa: solo extraemos la portada (desde el .cbr/.cbz) cuando la
// tarjeta entra en pantalla y no tiene ya una portada cacheada en el servidor.
function observeCovers() {
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        obs.unobserve(entry.target);
        loadCover(entry.target);
      }
    });
  }, { rootMargin: '400px 0px' });

  gridEl.querySelectorAll('.card').forEach((card) => {
    if (card._comic.coverUrl) return; // ya viene pintada de fabrica, nada que extraer
    io.observe(card);
  });
}

async function loadCover(card) {
  const comic = card._comic;
  const placeholder = card._placeholder;
  placeholder.classList.add('spinner');
  placeholder.textContent = '';

  let archive = null;
  try {
    const blob = await fetchComicBlob(comic);
    const result = await getSortedImageEntries(blob);
    archive = result.archive;
    const coverIndex = ['Ultimate Marvel', 'SpiderVerse'].includes(comic.category) ? 1 : 0;
    const cover = result.images[coverIndex];

    if (!cover) throw new Error('El comic no contiene imagenes');

    const extracted = await cover.file.extract();
    const thumbnail = await resizeImageBlob(extracted, COVER_MAX_WIDTH, COVER_MAX_HEIGHT, COVER_JPEG_QUALITY);
    const url = URL.createObjectURL(thumbnail);

    const img = document.createElement('img');
    img.src = url;
    img.alt = comic.title;
    img.loading = 'lazy';
    placeholder.replaceWith(img);

    // Forzamos extension .jpg: la miniatura siempre se recodifica como JPEG,
    // sea cual sea el formato original de la pagina (png/webp/etc).
    cacheCoverOnServer(comic, thumbnail, 'cover.jpg');
  } catch (err) {
    console.error(`Error extrayendo portada de ${comic.path}:`, err);
    placeholder.classList.remove('spinner');
    placeholder.textContent = '⚠️';
  } finally {
    closeArchive(archive);
  }
}

// Envia al servidor la portada recien extraida para que quede cacheada en disco
// (cache/covers/) y no haya que volver a desempaquetar el .cbr/.cbz en el futuro.
// Es "fire and forget": si falla (por ejemplo, sin PHP/XAMPP) simplemente la
// portada se seguira extrayendo en el navegador en cada visita, sin romper nada.
function cacheCoverOnServer(comic, blob, originalName) {
  const fd = new FormData();
  fd.append('category', comic.category);
  fd.append('path', comic.path);
  fd.append('cover', blob, originalName || 'cover.jpg');

  fetch('api/save-cover.php', { method: 'POST', body: fd })
    .then((res) => res.json())
    .then((data) => {
      if (data && data.ok) comic.coverUrl = data.url; // por si se repinta la tarjeta despues
    })
    .catch((err) => console.warn(`No se pudo cachear la portada de ${comic.path}:`, err));
}

/* ---------------- Buscador ---------------- */

searchInput.addEventListener('input', () => applyFilters());

/* ---------------- Reiniciar progreso ---------------- */

resetProgressBtn.addEventListener('click', () => {
  const ok = confirm('Esto borrara el progreso de lectura guardado (paginas y comics leidos) en este navegador. ¿Continuar?');
  if (!ok) return;
  progressMap = {};
  saveProgressMap();
  applyFilters(); // repinta las tarjetas sin los badges de progreso
});

/* ---------------- Lector ---------------- */

let readerState = {
  archive: null,
  pages: [],       // array de CompressedFile
  pageUrls: [],    // cache de blob URLs ya extraidas
  index: 0,
  comic: null,
};

async function openReader(comic) {
  readerState = { archive: null, pages: [], pageUrls: [], index: 0, comic };

  readerEl.classList.remove('hidden');
  readerTitleEl.textContent = `${comic.category} · ${comic.title}`;
  readerPageInfoEl.textContent = '';
  readerImageEl.src = '';
  readerLoadingEl.classList.remove('hidden');
  readerLoadingEl.textContent = 'Abriendo comic...';
  document.body.style.overflow = 'hidden';

  try {
    const blob = await fetchComicBlob(comic);
    const { archive, images } = await getSortedImageEntries(blob);
    if (images.length === 0) throw new Error('El comic no contiene imagenes');

    readerState.archive = archive;
    readerState.pages = images.map((e) => e.file);
    readerState.pageUrls = new Array(readerState.pages.length).fill(null);

    // Si ya habiamos leido este comic antes, retomamos por donde nos quedamos
    const saved = getProgress(comic);
    const defaultStartIndex = comic.category === 'Ultimate Marvel' ? 1 : 0;
    const startIndex = (saved && saved.page < readerState.pages.length)
      ? saved.page
      : defaultStartIndex;

    await showPage(startIndex);
  } catch (err) {
    console.error(`Error abriendo ${comic.path}:`, err);
    readerLoadingEl.textContent = 'No se ha podido abrir el comic.';
  }
}

async function showPage(index) {
  const { pages, comic } = readerState;
  if (index < 0 || index >= pages.length) return;
  readerState.index = index;

  readerPageInfoEl.textContent = `Pagina ${index + 1} / ${pages.length}`;
  readerPrevBtn.disabled = index === 0;
  readerNextBtn.disabled = index === pages.length - 1;

  readerLoadingEl.textContent = 'Cargando pagina...';
  readerLoadingEl.classList.remove('hidden');
  readerLoadingEl.classList.remove('error');

  let url;
  try {
    url = await getPageUrl(index);
  } catch (err) {
    console.error(`Error extrayendo pagina ${index + 1} de ${comic.path}:`, err);
    if (readerState.index !== index) return; // el usuario ya navego a otra pagina mientras fallaba esta

    readerLoadingEl.textContent = isUnsupportedFilterError(err)
      ? 'Esta pagina usa un metodo de compresion RAR no soportado por el lector. Prueba a recomprimir este comic como .cbz.'
      : 'No se ha podido cargar esta pagina.';
    readerLoadingEl.classList.remove('hidden');
    readerLoadingEl.classList.add('error');
    return;
  }

  // Evita pintar una pagina obsoleta si el usuario navego rapido mientras cargaba
  if (readerState.index !== index) return;

  readerImageEl.src = url;
  readerLoadingEl.classList.add('hidden');
  readerLoadingEl.classList.remove('error');

  setProgress(comic, index, pages.length);

  prefetchPage(index + 1);
}

// libarchive.js (el port WASM de libarchive) no soporta ciertos "filtros" de
// compresion RAR (delta/BCJ/multimedia), habituales en perfiles "Best" de
// WinRAR. Cuando eso ocurre, lanza este error de forma bastante generica.
function isUnsupportedFilterError(err) {
  return !!(err && typeof err.message === 'string' && err.message.includes('Parsing filters is unsupported'));
}

async function getPageUrl(index) {
  if (readerState.pageUrls[index]) return readerState.pageUrls[index];
  const file = await readerState.pages[index].extract();
  const url = URL.createObjectURL(file);
  readerState.pageUrls[index] = url;
  return url;
}

function prefetchPage(index) {
  if (index < 0 || index >= readerState.pages.length) return;
  if (readerState.pageUrls[index]) return;
  getPageUrl(index).catch(() => {});
}

function closeReader() {
  readerEl.classList.add('hidden');
  document.body.style.overflow = '';
  readerState.pageUrls.forEach((url) => url && URL.revokeObjectURL(url));
  closeArchive(readerState.archive);
  readerState = { archive: null, pages: [], pageUrls: [], index: 0, comic: null };

  // Puede haber cambiado el progreso: repintamos para refrescar los badges de las tarjetas
  applyFilters();
}

readerPrevBtn.addEventListener('click', () => showPage(readerState.index - 1));
readerNextBtn.addEventListener('click', () => showPage(readerState.index + 1));
readerCloseBtn.addEventListener('click', closeReader);

document.addEventListener('keydown', (e) => {
  if (readerEl.classList.contains('hidden')) return;
  if (e.key === 'Escape') closeReader();
  else if (e.key === 'ArrowLeft') showPage(readerState.index - 1);
  else if (e.key === 'ArrowRight') showPage(readerState.index + 1);
});

/* ---------------- Init ---------------- */

loadCategoryInfo().then(loadComicsList);