window.addEventListener("DOMContentLoaded", () => {
    Promise.all([
        fetch("./components/header.html")
            .then(res => res.text())
            .then(data => document.getElementById("header").innerHTML = data),
        fetch("./components/footer.html")
            .then(res => res.text())
            .then(data => document.getElementById("footer").innerHTML = data),
        document.fonts.ready
    ])
    .then(() => {
        document.body.style.visibility = "visible";
    })
    .catch(err => {
        console.error("Error cargando header/footer:", err);
        document.body.style.visibility = "visible";
    });
});