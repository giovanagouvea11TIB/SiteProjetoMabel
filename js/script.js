const carousel = document.querySelector('.components-carousel');

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