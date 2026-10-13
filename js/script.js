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
    const apiUrl = (path) => window.location.port === '5500'
        ? `http://${window.location.hostname}:3000${path}`
        : path;
    const apiFetch = (path, options = {}) => {
        const url = apiUrl(path);
        const origin = new URL(url, window.location.href).origin;

        return fetch(url, {
            ...options,
            credentials: origin === window.location.origin ? 'same-origin' : 'include'
        });
    };

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

    const accountContainer = document.querySelector('.nav-actions');
    const profileLink = accountContainer?.querySelector('a.profile');
    let accountToggle = accountContainer?.querySelector('.account-toggle');
    let accountMenu = accountContainer?.querySelector('.account-menu');
    let refreshAccount = () => Promise.resolve();

    if (accountContainer && !accountContainer.dataset.accountMenuBound) {
        accountContainer.dataset.accountMenuBound = 'true';

        if (profileLink) {
            accountToggle = document.createElement('button');
            accountToggle.type = 'button';
            accountToggle.className = 'account-toggle';
            accountToggle.setAttribute('aria-label', 'Menu da conta');
            accountToggle.setAttribute('aria-expanded', 'false');
            accountToggle.setAttribute('aria-haspopup', 'true');
            accountToggle.setAttribute('aria-controls', 'account-menu');

            const avatar = profileLink.querySelector('img');
            if (avatar) {
                avatar.className = 'account-avatar';
                avatar.alt = '';
                accountToggle.append(avatar);
            }

            profileLink.replaceWith(accountToggle);
        }

        if (accountToggle) {
            accountMenu = document.createElement('div');
            accountMenu.id = 'account-menu';
            accountMenu.className = 'account-menu';
            accountMenu.hidden = true;
            accountContainer.append(accountMenu);

            const mobileUserCard = document.querySelector('.user-card-item');
            const mobileUserLink = mobileUserCard?.querySelector('.user-card-link');
            const mobileUserName = mobileUserCard?.querySelector('.user-name');
            let sessionRequest = null;

            function updateMobileUserCard(state, user) {
                if (!mobileUserLink || !mobileUserName) return;

                if (state === 'authenticated') {
                    mobileUserName.textContent = user.nome || 'Minha conta';
                    mobileUserLink.href = '/software/perfil/perfil.html';
                } else if (state === 'visitor') {
                    mobileUserName.textContent = 'Entrar';
                    mobileUserLink.href = '/pages/login/login.html';
                } else {
                    mobileUserName.textContent = state === 'error'
                        ? 'Conta indisponível'
                        : 'Verificando conta...';
                }
            }

            function createIcon(pathData) {
                const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

                icon.setAttribute('viewBox', '0 0 24 24');
                icon.setAttribute('width', '20');
                icon.setAttribute('height', '20');
                icon.setAttribute('fill', 'none');
                icon.setAttribute('stroke', 'currentColor');
                icon.setAttribute('stroke-width', '2');
                icon.setAttribute('stroke-linecap', 'round');
                icon.setAttribute('stroke-linejoin', 'round');
                icon.setAttribute('aria-hidden', 'true');
                path.setAttribute('d', pathData);
                icon.append(path);

                return icon;
            }

            function addMenuItem(label, iconPath, href, onClick) {
                const item = document.createElement(href ? 'a' : 'button');
                const icon = document.createElement('span');
                const text = document.createElement('span');

                item.className = href ? 'account-menu-link' : 'account-logout';
                if (href) {
                    item.href = href;
                } else {
                    item.type = 'button';
                }

                icon.className = 'account-menu-icon';
                icon.append(createIcon(iconPath));
                text.textContent = label;
                item.append(icon, text);
                if (onClick) item.addEventListener('click', onClick);
                accountMenu.append(item);

                return item;
            }

            function renderAccountMenu(state, user, message = '') {
                accountMenu.replaceChildren();

                if (state === 'authenticated') {
                    const identity = document.createElement('div');
                    const avatar = document.createElement('img');
                    const name = document.createElement('span');

                    identity.className = 'account-menu-user';
                    avatar.src = accountToggle.querySelector('img')?.src || '/assets/images/foto-de-perfil.png';
                    avatar.alt = '';
                    name.textContent = user.nome || 'Minha conta';
                    identity.append(avatar, name);
                    accountMenu.append(identity);
                    addMenuItem('Meu perfil', 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', '/software/perfil/perfil.html');
                    addMenuItem('Sair da conta', 'M10 17l5-5-5-5M15 12H3m8-7h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8', null, logout);
                } else if (state === 'visitor') {
                    addMenuItem('Entrar', 'M10 17l5-5-5-5M15 12H3m8-7h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8', '/pages/login/login.html');
                    addMenuItem('Criar conta', 'M12 5v14m-7-7h14', '/pages/cadastro/cadastro.html');
                } else if (state === 'error') {
                    const retry = addMenuItem('Tentar novamente', 'M20 7v5h-5M4 17v-5h5M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2', null, refreshAccount);
                    retry.classList.add('account-menu-retry');
                }

                const status = document.createElement('p');
                status.className = 'account-menu-status';
                status.setAttribute('role', 'status');
                status.setAttribute('aria-live', 'polite');
                status.textContent = message;
                accountMenu.append(status);
            }

            function closeAccountMenu() {
                accountMenu.hidden = true;
                accountToggle.setAttribute('aria-expanded', 'false');
            }

            async function logout(event) {
                event?.preventDefault();

                const button = accountMenu.querySelector('.account-logout');
                const status = accountMenu.querySelector('.account-menu-status');
                if (!button || button.disabled) return;

                button.disabled = true;
                button.lastElementChild.textContent = 'Saindo...';
                status.textContent = '';

                try {
                    const response = await apiFetch('/api/auth/logout', { method: 'POST' });
                    const result = await response.json().catch(() => null);

                    if (!response.ok || result?.sucesso !== true) {
                        throw new Error(result?.mensagem || 'Não foi possível encerrar a sessão.');
                    }

                    renderAccountMenu('visitor', null);
                    updateMobileUserCard('visitor');
                    closeAccountMenu();
                    window.location.assign('/index.html');
                } catch (erro) {
                    status.textContent = erro.message || 'Não foi possível encerrar a sessão. Tente novamente.';
                    button.disabled = false;
                    button.lastElementChild.textContent = 'Sair da conta';
                }
            }

            refreshAccount = function refreshAccountSession() {
                if (sessionRequest) return sessionRequest;

                renderAccountMenu('loading', null);
                updateMobileUserCard('loading');
                sessionRequest = (async () => {
                    try {
                        const response = await apiFetch('/api/auth/sessao');
                        const result = await response.json().catch(() => null);

                        if (!response.ok || typeof result?.autenticado !== 'boolean') {
                            throw new Error('Não foi possível verificar a sessão.');
                        }

                        if (result.autenticado) {
                            const user = {
                                nome: typeof result.usuario?.nome === 'string'
                                    ? result.usuario.nome.trim()
                                    : ''
                            };
                            renderAccountMenu('authenticated', user);
                            updateMobileUserCard('authenticated', user);
                        } else {
                            renderAccountMenu('visitor', null);
                            updateMobileUserCard('visitor');
                        }
                    } catch (erro) {
                        renderAccountMenu('error', null, erro.message || 'Não foi possível verificar a sessão.');
                        updateMobileUserCard('error');
                    } finally {
                        sessionRequest = null;
                    }
                })();

                return sessionRequest;
            };

            accountToggle.addEventListener('click', (event) => {
                event.stopPropagation();
                const opening = accountMenu.hidden;
                accountMenu.hidden = !opening;
                accountToggle.setAttribute('aria-expanded', String(opening));
            });

            accountMenu.addEventListener('click', (event) => {
                if (event.target.closest('a')) closeAccountMenu();
            });

            document.addEventListener('click', (event) => {
                if (!accountContainer.contains(event.target)) closeAccountMenu();
            });

            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape' && !accountMenu.hidden) {
                    closeAccountMenu();
                    accountToggle.focus();
                }
            });

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') refreshAccount();
            });

            refreshAccount();
        }
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
                const respostaCadastro = await apiFetch('/api/auth/cadastro', {
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
                const resposta = await apiFetch('/api/auth/login', {
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
                else if (accountToggle) await refreshAccount();
            } catch (erro) {
                window.alert('Nao foi possivel conectar ao servidor. Tente novamente.');
            } finally {
                if (botao) botao.disabled = false;
            }
        });
    }
});