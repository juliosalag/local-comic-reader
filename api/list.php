<?php
/**
 * Devuelve, en JSON, el listado de comics (.cbr/.cbz) organizados por categoria.
 * Cada subcarpeta directa dentro de /comics se trata como una categoria
 * (ej. /comics/Marvel, /comics/Manga...). Los archivos sueltos que esten
 * directamente en /comics (sin subcarpeta) se agrupan en la categoria "Otros".
 *
 * Dentro de cada categoria, se usa el numero inicial del nombre de archivo
 * (ej. "0001 - Titulo.cbr") para ordenar y separar numero/titulo.
 */

header('Content-Type: application/json; charset=utf-8');

// Carpeta donde estan los comics, relativa a este script (api/../comics)
$comicsDir = __DIR__ . '/../comics';

if (!is_dir($comicsDir)) {
    http_response_code(500);
    echo json_encode([
        'error' => true,
        'message' => 'No se encuentra la carpeta comics en: ' . realpath(__DIR__ . '/..')
    ]);
    exit;
}

/**
 * Escanea un directorio (sin bajar a subcarpetas) en busca de .cbr/.cbz
 * @param string $dirPath   ruta fisica del directorio a escanear
 * @param string $relPrefix prefijo relativo a /comics para poder reconstruir la URL
 *                          (vacio si son los archivos sueltos de la raiz)
 */
function scanComicsInDir($dirPath, $relPrefix) {
    $comics = [];
    foreach (scandir($dirPath) as $file) {
        if ($file === '.' || $file === '..') continue;

        $fullPath = $dirPath . '/' . $file;
        if (!is_file($fullPath)) continue;

        $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
        if ($ext !== 'cbr' && $ext !== 'cbz') continue;

        $nameNoExt = pathinfo($file, PATHINFO_FILENAME);

        $number = null;
        $title = $nameNoExt;

        if (preg_match('/^(\d+)\s*-\s*(.+)$/', $nameNoExt, $matches)) {
            $number = (int)$matches[1];
            $title = trim($matches[2]);
        } elseif (preg_match('/^(\d+)/', $nameNoExt, $matches)) {
            $number = (int)$matches[1];
        }

        $relPath = $relPrefix === '' ? $file : $relPrefix . '/' . $file;

        $comics[] = [
            'file'      => $file,
            'path'      => $relPath, // ruta relativa a /comics, usada para descargar el archivo
            'number'    => $number,
            'title'     => $title,
            'ext'       => $ext,
            'sizeBytes' => filesize($fullPath),
            'modified'  => filemtime($fullPath),
        ];
    }

    usort($comics, function ($a, $b) {
        if ($a['number'] === null && $b['number'] === null) {
            return strcmp($a['file'], $b['file']);
        }
        if ($a['number'] === null) return 1;
        if ($b['number'] === null) return -1;
        if ($a['number'] === $b['number']) {
            return strcmp($a['file'], $b['file']);
        }
        return $a['number'] <=> $b['number'];
    });

    return $comics;
}

$categories = [];

// 1) Archivos sueltos directamente en /comics -> categoria "Otros"
$rootComics = scanComicsInDir($comicsDir, '');
if (!empty($rootComics)) {
    $categories[] = [
        'name'   => 'Otros',
        'comics' => $rootComics,
    ];
}

// 2) Cada subcarpeta directa de /comics -> una categoria
$subDirs = [];
foreach (scandir($comicsDir) as $entry) {
    if ($entry === '.' || $entry === '..') continue;
    if (is_dir($comicsDir . '/' . $entry)) $subDirs[] = $entry;
}
sort($subDirs, SORT_NATURAL | SORT_FLAG_CASE);

foreach ($subDirs as $entry) {
    $comics = scanComicsInDir($comicsDir . '/' . $entry, $entry);
    if (!empty($comics)) {
        $categories[] = [
            'name'   => $entry,
            'comics' => $comics,
        ];
    }
}

/**
 * Si la portada de un comic ya fue extraida y cacheada en disco por
 * api/save-cover.php, adjuntamos su URL para que el navegador la use
 * directamente sin tener que volver a descargar y desempaquetar el .cbr/.cbz.
 * La clave debe coincidir exactamente con la que genera save-cover.php.
 */
$coversDir = __DIR__ . '/../cache/covers';
if (is_dir($coversDir)) {
    foreach ($categories as &$cat) {
        foreach ($cat['comics'] as &$comic) {
            $key = md5($cat['name'] . '|' . $comic['path'] . '|' . $comic['modified']);
            $matches = glob($coversDir . '/' . $key . '.*');
            $comic['coverUrl'] = !empty($matches) ? 'cache/covers/' . basename($matches[0]) : null;
        }
        unset($comic);
    }
    unset($cat);
}

$total = 0;
foreach ($categories as $cat) $total += count($cat['comics']);

echo json_encode([
    'error'      => false,
    'count'      => $total,
    'categories' => $categories,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
