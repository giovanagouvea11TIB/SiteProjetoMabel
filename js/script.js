const themeToggle = document.getElementById("theme-toggle");
const themeIcon = document.getElementById("theme-icon");

themeToggle.addEventListener("click", function () {

    document.body.classList.toggle("dark-mode");

    if (document.body.classList.contains("dark-mode")) {
        themeIcon.textContent = "☀";
    } else {
        themeIcon.textContent = "☾";
    }

});

const carousel = document.querySelector('.components-carousel');

if (carousel) {

    let isDown = false;
    let startX;
    let scrollLeft;

    carousel.addEventListener('mousedown', (e) => {
        isDown = true;

        startX = e.pageX - carousel.offsetLeft;
        scrollLeft = carousel.scrollLeft;
    });

    carousel.addEventListener('mouseleave', () => {
        isDown = false;
    });

    carousel.addEventListener('mouseup', () => {
        isDown = false;
    });

    carousel.addEventListener('mousemove', (e) => {

        if (!isDown) return;

        e.preventDefault();

        const x = e.pageX - carousel.offsetLeft;
        const walk = (x - startX) * 2;

        carousel.scrollLeft = scrollLeft - walk;
    });

}