#!/usr/bin/env python3
"""
Servidor local en Python que:
- Usa ThreadingTCPServer sin límite de conexiones concurrentes.
- Sirve archivos desde la carpeta donde está este script.
- Ejecuta archivos .php a través de php-cgi (protocolo CGI).
- En consola: al arrancar muestra el diagnóstico completo. Una vez arrancado,
  solo loguea errores/avisos y conexiones nuevas (no cada petición de asset).

Requisitos:
- Tener instalado php-cgi y accesible en el PATH (o indicar la ruta completa
  en PHP_CGI más abajo).
  * Windows: viene con la instalación de PHP como "php-cgi.exe"
  * Linux (Debian/Ubuntu): sudo apt install php-cgi
  * Mac (Homebrew): brew install php  (incluye php-cgi)

Uso:
    python php_server.py
    (o) python php_server.py 8080      -> para cambiar el puerto
"""

import http.server
import socketserver
import threading
import subprocess
import shutil
import time
import os
import sys
import urllib.parse
from datetime import datetime

# --- Configuración ---
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 80
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
PHP_CGI = r"C:\php\php-cgi.exe"  # cambia esto a la ruta completa si no está en el PATH

_seen_clients_lock = threading.Lock()
_seen_clients = set()


def log(level, msg):
    """Log uniforme con timestamp y nivel: INFO / OK / WARN / ERROR."""
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] [{level:<5}] {msg}")


def check_environment():
    """Comprueba requisitos al arrancar e informa de lo que falta."""
    log("INFO", f"Carpeta servida: {DIRECTORY}")
    log("INFO", f"Puerto: {PORT}")

    php_cgi_path = shutil.which(PHP_CGI) if os.path.basename(PHP_CGI) == PHP_CGI else (
        PHP_CGI if os.path.isfile(PHP_CGI) else None
    )
    if php_cgi_path:
        log("OK", f"php-cgi encontrado en: {php_cgi_path}")
        try:
            result = subprocess.run([PHP_CGI, "-v"], capture_output=True, text=True, timeout=5)
            first_line = result.stdout.strip().splitlines()[0] if result.stdout.strip() else "?"
            log("INFO", f"Versión: {first_line}")
        except Exception as e:
            log("WARN", f"No se pudo obtener la versión de php-cgi: {e}")
    else:
        log("ERROR", f"FALTA: no se encontró '{PHP_CGI}' en el PATH.")
        log("ERROR", "Instálalo o ajusta la variable PHP_CGI al inicio del script con la ruta completa.")
        log("WARN", "El servidor arrancará igualmente, pero las peticiones .php fallarán.")

    index_candidates = ["index.php", "index.html"]
    found_index = [f for f in index_candidates if os.path.isfile(os.path.join(DIRECTORY, f))]
    if found_index:
        log("OK", f"Archivo(s) de entrada detectados: {', '.join(found_index)}")
    else:
        log("WARN", f"No hay index.php ni index.html en {DIRECTORY} (no es obligatorio, solo aviso).")

    print("-" * 60)


class ThreadedServer(socketserver.ThreadingTCPServer):
    """ThreadingTCPServer sin límite de hilos concurrentes."""
    daemon_threads = True
    allow_reuse_address = True

    def process_request(self, request, client_address):
        ip = client_address[0]
        with _seen_clients_lock:
            is_new = ip not in _seen_clients
            _seen_clients.add(ip)
        if is_new:
            log("INFO", f"Nueva conexión desde {ip}")
        super().process_request(request, client_address)


# Windows a veces tiene el registro de tipos MIME mal configurado (p.ej. .js
# como "text/plain"), lo que hace que los navegadores bloqueen en silencio los
# <script type="module"> servidos con el Content-Type incorrecto. Forzamos los
# tipos correctos aqui para no depender del sistema operativo.
FORCED_MIME_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
}


class PHPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in FORCED_MIME_TYPES:
            return FORCED_MIME_TYPES[ext]
        return super().guess_type(path)

    def do_GET(self):
        self.handle_request("GET")

    def do_POST(self):
        self.handle_request("POST")

    def handle_request(self, method):
        parsed = urllib.parse.urlparse(self.path)
        decoded_path = urllib.parse.unquote(parsed.path)
        local_path = os.path.join(DIRECTORY, decoded_path.lstrip("/"))

        if parsed.path.endswith(".php"):
            if os.path.isfile(local_path):
                self.run_php(local_path, parsed, method)
            else:
                log("WARN", f"FALTA: no existe el archivo PHP solicitado: {local_path}")
                self.send_error(404, "Archivo PHP no encontrado")
        else:
            if method == "GET":
                if not os.path.exists(local_path):
                    log("WARN", f"FALTA: recurso no encontrado: {local_path}")
                super().do_GET()
            else:
                log("WARN", f"Método {method} no permitido para archivos estáticos")
                self.send_error(405, "Método no permitido para archivos estáticos")

    def run_php(self, script_path, parsed_url, method):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b""

        env = os.environ.copy()
        env.update({
            "REDIRECT_STATUS": "1",
            "GATEWAY_INTERFACE": "CGI/1.1",
            "SERVER_PROTOCOL": "HTTP/1.1",
            "SERVER_SOFTWARE": "PythonPHPServer/1.0",
            "REQUEST_METHOD": method,
            "SCRIPT_FILENAME": script_path,
            "SCRIPT_NAME": parsed_url.path,
            "QUERY_STRING": parsed_url.query,
            "REQUEST_URI": self.path,
            "DOCUMENT_ROOT": DIRECTORY,
            "SERVER_NAME": "localhost",
            "SERVER_PORT": str(PORT),
            "REMOTE_ADDR": self.client_address[0],
            "CONTENT_LENGTH": str(content_length),
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
        })

        try:
            proc = subprocess.run(
                [PHP_CGI],
                input=body,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                cwd=os.path.dirname(script_path),
                timeout=30,
            )
        except FileNotFoundError:
            log("ERROR", f"FALTA: '{PHP_CGI}' no está instalado o no está en el PATH.")
            self.send_error(
                500,
                f"No se encontró '{PHP_CGI}'. Instala php-cgi o ajusta PHP_CGI en el script."
            )
            return
        except subprocess.TimeoutExpired:
            log("ERROR", f"Timeout: {os.path.basename(script_path)} tardó más de 30s en responder.")
            self.send_error(504, "El script PHP tardó demasiado en responder")
            return

        if proc.stderr:
            stderr_text = proc.stderr.decode(errors="replace").strip()
            if stderr_text:
                log("WARN", f"php-cgi stderr para {os.path.basename(script_path)}:\n{stderr_text}")

        if proc.returncode != 0 and not proc.stdout:
            log("ERROR", f"php-cgi terminó con código {proc.returncode} y sin salida.")
            self.send_error(500, f"Error ejecutando PHP:\n{proc.stderr.decode(errors='replace')}")
            return

        # La salida de php-cgi trae cabeceras CGI + línea en blanco + cuerpo
        raw_output = proc.stdout
        header_end = raw_output.find(b"\r\n\r\n")
        sep_len = 4
        if header_end == -1:
            header_end = raw_output.find(b"\n\n")
            sep_len = 2

        if header_end == -1:
            headers_block, response_body = b"", raw_output
        else:
            headers_block = raw_output[:header_end]
            response_body = raw_output[header_end + sep_len:]

        status_code = 200
        response_headers = []
        for line in headers_block.decode(errors="replace").split("\n"):
            line = line.strip()
            if not line:
                continue
            if line.lower().startswith("status:"):
                status_code = int(line.split(":", 1)[1].strip().split()[0])
            else:
                if ":" in line:
                    key, value = line.split(":", 1)
                    response_headers.append((key.strip(), value.strip()))

        if status_code >= 400:
            log("ERROR", f"PHP {os.path.basename(script_path)} -> {status_code}")

        self.send_response(status_code)
        for key, value in response_headers:
            self.send_header(key, value)
        if not any(k.lower() == "content-length" for k, _ in response_headers):
            self.send_header("Content-Length", str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)

    def log_message(self, format, *args):
        # Silenciado: solo logueamos manualmente errores/avisos y conexiones nuevas.
        pass


def run_server():
    print("=" * 60)
    log("INFO", "Iniciando servidor...")
    check_environment()
    with ThreadedServer(("", PORT), PHPRequestHandler) as httpd:
        log("OK", f"Servidor activo en http://localhost:{PORT}")
        log("INFO", "Ctrl+C para parar.")
        print("-" * 60)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()
            log("INFO", "Deteniendo servidor...")
            httpd.shutdown()
            log("OK", "Servidor detenido.")


if __name__ == "__main__":
    run_server()
