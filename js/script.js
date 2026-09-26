//dark mode
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

//carrosel
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

//hamburguer
document.addEventListener('DOMContentLoaded', () => {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const navLinks = document.getElementById('nav-links');
    const menuOverlay = document.getElementById('menu-overlay');

    function openMenu() {
        navLinks.classList.add('active');
        if (menuOverlay) menuOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeMenu() {
        navLinks.classList.remove('active');
        if (menuOverlay) menuOverlay.classList.remove('active');
        document.body.style.overflow = '';
    }

    if (hamburgerBtn && navLinks) {
        hamburgerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (navLinks.classList.contains('active')) {
                closeMenu();
            } else {
                openMenu();
            }
        });

        if (menuOverlay) {
            menuOverlay.addEventListener('click', closeMenu);
        }

        // Fecha o menu ao clicar em qualquer link interno
        navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', closeMenu);
        });
    }

    const cadastroForm = document.querySelector('.register-form');
    if (cadastroForm && cadastroForm.dataset.welcomeBound !== 'true') {
        cadastroForm.dataset.welcomeBound = 'true';
        cadastroForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!cadastroForm.reportValidity()) return;

            const botao = cadastroForm.querySelector('button[type="submit"]');
            if (botao) botao.disabled = true;

            try {
                const dados = Object.fromEntries(new FormData(cadastroForm).entries());
                const respostaCadastro = await fetch('/api/auth/cadastro', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(dados)
                });
                const resultadoCadastro = await respostaCadastro.json();

                if (!respostaCadastro.ok || !resultadoCadastro.sucesso) {
                    window.alert(resultadoCadastro.mensagem || 'Nao foi possivel realizar o cadastro.');
                    return;
                }

                window.alert(resultadoCadastro.emailEnviado === true
                    ? 'Cadastro realizado e e-mail de boas-vindas enviado!'
                    : 'Cadastro realizado, mas nao foi possivel enviar o e-mail de boas-vindas.');

                const destino = cadastroForm.dataset.redirect;
                if (destino && destino !== '#') window.location.assign(destino);
            } catch (erro) {
                window.alert('Nao foi possivel conectar ao servidor. Tente novamente.');
            } finally {
                if (botao) botao.disabled = false;
            }
        });
    }

    const loginForm = document.querySelector('.auth-form');
    if (loginForm && loginForm.dataset.loginBound !== 'true') {
        loginForm.dataset.loginBound = 'true';
        loginForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!loginForm.reportValidity()) return;

            const botao = loginForm.querySelector('button[type="submit"]');
            if (botao) botao.disabled = true;

            try {
                const dados = Object.fromEntries(new FormData(loginForm).entries());
                const resposta = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(dados)
                });
                const resultado = await resposta.json();

                if (!resposta.ok || !resultado.sucesso) {
                    window.alert(resultado.mensagem || 'E-mail ou senha incorretos.');
                    return;
                }

                const destino = loginForm.dataset.redirect;
                if (destino && destino !== '#') window.location.assign(destino);
            } catch (erro) {
                window.alert('Nao foi possivel conectar ao servidor. Tente novamente.');
            } finally {
                if (botao) botao.disabled = false;
            }
        });
    }
});