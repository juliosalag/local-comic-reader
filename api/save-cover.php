<?php
/**
 * Guarda en disco la portada de un comic, extraida previamente en el navegador.
 * Asi solo se desempaqueta el .cbr/.cbz una vez (la primera persona que lo abre);
 * las siguientes visitas sirven directamente el archivo de imagen ya cacheado.
 *
 * Espera un POST multipart/form-data con:
 *   - category: nombre de la categoria (tal cual la devuelve list.php)
 *   - path:     ruta del comic relativa a /comics (comic.path)
 *   - cover:    fichero de imagen (la portada ya extraida)
 *
 * La clave de cache incluye la fecha de modificacion del .cbr/.cbz, asi que si
 * el archivo se reemplaza por una version distinta, se genera una clave nueva
 * y la portada se vuelve a extraer automaticamente en la siguiente visita.
 */

header('Content-Type: application/json; charset=utf-8');

function fail($message, $code = 400) {
    http_response_code($code);
    echo json_encode(['ok' => false, 'message' => $message]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('Metodo no permitido', 405);

$category = isset($_POST['category']) ? (string)$_POST['category'] : '';
$path     = isset($_POST['path']) ? (string)$_POST['path'] : '';

if ($category === '' || $path === '') fail('Faltan parametros (category, path)');
if (!isset($_FILES['cover']) || $_FILES['cover']['error'] !== UPLOAD_ERR_OK) fail('Falta el fichero de portada');

$comicsDir = realpath(__DIR__ . '/../comics');
if ($comicsDir === false) fail('No se encuentra la carpeta comics', 500);

// Resolvemos el comic real a partir del path recibido, evitando path traversal
// (el resultado debe quedar siempre dentro de /comics).
$candidate = realpath($comicsDir . '/' . $path);
if ($candidate === false || strpos($candidate, $comicsDir . DIRECTORY_SEPARATOR) !== 0) {
    fail('Ruta de comic invalida');
}
if (!is_file($candidate)) fail('El comic no existe');

$modified = filemtime($candidate);
$key = md5($category . '|' . $path . '|' . $modified);

// Extension segura a partir del nombre original de la imagen extraida
$allowedExt = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
$ext = strtolower(pathinfo($_FILES['cover']['name'], PATHINFO_EXTENSION));
if (!in_array($ext, $allowedExt, true)) $ext = 'jpg';

$coversDir = __DIR__ . '/../cache/covers';
if (!is_dir($coversDir) && !mkdir($coversDir, 0775, true) && !is_dir($coversDir)) {
    fail('No se pudo crear la carpeta de cache', 500);
}

// Si ya existe una portada cacheada para esta misma clave con otra extension, la limpiamos
foreach (glob($coversDir . '/' . $key . '.*') as $old) {
    @unlink($old);
}

$destPath = $coversDir . '/' . $key . '.' . $ext;
if (!move_uploaded_file($_FILES['cover']['tmp_name'], $destPath)) {
    fail('No se pudo guardar la portada', 500);
}

echo json_encode([
    'ok'  => true,
    'url' => 'cache/covers/' . $key . '.' . $ext,
]);
