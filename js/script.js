const themeToggle = document.getElementById("theme-toggle");
const themeIcon = document.getElementById("theme-icon");
const THEME_STORAGE_KEY = "mabel.theme";

function applyTheme(theme, persist = false) {
    const darkMode = theme === "dark";
    document.body.classList.toggle("dark-mode", darkMode);
    document.documentElement.classList.toggle("dark-mode", darkMode);

    if (themeIcon) themeIcon.textContent = darkMode ? "☀" : "☾";
    if (themeToggle) {
        themeToggle.setAttribute(
            "aria-label",
            darkMode ? "Ativar tema claro" : "Ativar tema escuro"
        );
        const label = themeToggle.querySelector(".theme-label");
        if (label) label.textContent = darkMode ? "Ativar tema claro" : "Ativar tema escuro";
    }

    if (persist) {
        try {
            window.localStorage.setItem(THEME_STORAGE_KEY, darkMode ? "dark" : "light");
        } catch {
            // Keep the selected theme for this page when browser storage is unavailable.
        }
    }
}

let savedTheme = "light";
try {
    savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
} catch {
    savedTheme = "light";
}
applyTheme(savedTheme);

if (themeToggle) {
    themeToggle.addEventListener("click", () => {
        applyTheme(document.body.classList.contains("dark-mode") ? "light" : "dark", true);
    });
}

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
    const apiFetch = async (path, options = {}) => {
        const url = apiUrl(path);
        const origin = new URL(url, window.location.href).origin;

        try {
            return await fetch(url, {
                ...options,
                credentials: origin === window.location.origin ? 'same-origin' : 'include'
            });
        } catch {
            throw new Error('Não foi possível conectar ao servidor; nenhuma resposta HTTP foi recebida.');
        }
    };
    const readApiJson = async (response) => {
        if (
            !response
            || typeof response.json !== 'function'
            || typeof response.ok !== 'boolean'
            || typeof response.status !== 'number'
        ) {
            throw new Error('A solicitação não recebeu uma resposta HTTP válida.');
        }

        try {
            return { response, result: await response.json() };
        } catch {
            if (!response.ok) return { response, result: null };
            throw new Error(`O servidor respondeu HTTP ${response.status}, mas retornou dados inválidos.`);
        }
    };
    const apiErrorMessage = (response, result, fallback) => {
        if (typeof result?.mensagem === 'string' && result.mensagem) return result.mensagem;
        if (response?.ok === false) {
            return `O servidor respondeu com HTTP ${response.status}, sem uma mensagem de erro legível.`;
        }
        return fallback;
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
    let menuToggle = accountContainer?.querySelector('.account-menu-toggle');
    let accountMenu = accountContainer?.querySelector('.account-menu');
    let refreshAccount = () => Promise.resolve();

    if (accountContainer && !accountContainer.dataset.accountMenuBound) {
        accountContainer.dataset.accountMenuBound = 'true';

        const avatarOptions = [
            { id: 'paw', label: 'Pata', icon: '🐾' },
            { id: 'flower', label: 'Flor', icon: '🌼' },
            { id: 'heart', label: 'Coração', icon: '❤️' },
            { id: 'star', label: 'Estrela', icon: '⭐' },
            { id: 'fish', label: 'Peixe', icon: '🐟' },
            { id: 'dog', label: 'Cachorro', icon: '🐶' },
            { id: 'cat', label: 'Gato', icon: '🐱' },
            { id: 'horse', label: 'Cavalo', icon: '🐴' },
            { id: 'butterfly', label: 'Borboleta', icon: '🦋' },
            { id: 'rabbit', label: 'Coelho', icon: '🐰' },
            { id: 'bird', label: 'Pássaro', icon: '🐦' },
            { id: 'leaf', label: 'Folha', icon: '🍃' }
        ];
        let selectedAvatar = 'paw';
        let isAuthenticated = false;
        let avatarDialog;
        let avatarDialogStatus;

        function avatarOption(id) {
            return avatarOptions.find((option) => option.id === id) || avatarOptions[0];
        }

        function makeAvatarSymbol(className, id) {
            const symbol = document.createElement('span');
            symbol.className = className;
            symbol.setAttribute('aria-hidden', 'true');
            symbol.textContent = avatarOption(id).icon;
            return symbol;
        }

        function updateAvatarUI(id) {
            selectedAvatar = avatarOption(id).id;
            const label = avatarOption(selectedAvatar).label;
            const headerSymbol = accountToggle?.querySelector('.avatar-symbol');
            if (headerSymbol) headerSymbol.textContent = avatarOption(selectedAvatar).icon;
            if (accountToggle) {
                accountToggle.setAttribute(
                    'aria-label',
                    isAuthenticated ? `Alterar avatar. Avatar atual: ${label}` : 'Menu da conta'
                );
                accountToggle.setAttribute('aria-haspopup', isAuthenticated ? 'dialog' : 'true');
                accountToggle.setAttribute('aria-controls', isAuthenticated ? 'avatar-picker' : 'account-menu');
            }

            const mobileSymbol = document.querySelector('.user-card-item .user-avatar-symbol');
            if (mobileSymbol) {
                mobileSymbol.textContent = avatarOption(selectedAvatar).icon;
                mobileSymbol.setAttribute('aria-label', `Alterar avatar. Avatar atual: ${label}`);
            }

            const menuSymbol = accountMenu?.querySelector('.account-menu-avatar-symbol');
            if (menuSymbol) menuSymbol.textContent = avatarOption(selectedAvatar).icon;
            const pickerButton = accountMenu?.querySelector('.account-menu-avatar-picker');
            if (pickerButton) pickerButton.setAttribute('aria-label', `Alterar avatar. Avatar atual: ${label}`);

            avatarDialog?.querySelectorAll('.avatar-option').forEach((button) => {
                button.setAttribute('aria-pressed', String(button.dataset.avatarId === selectedAvatar));
            });
        }

        function createAvatarDialog() {
            avatarDialog = document.createElement('dialog');
            avatarDialog.className = 'avatar-picker-dialog';
            avatarDialog.id = 'avatar-picker';
            avatarDialog.setAttribute('aria-labelledby', 'avatar-picker-title');

            const header = document.createElement('div');
            header.className = 'avatar-picker-header';
            const title = document.createElement('h2');
            title.id = 'avatar-picker-title';
            title.textContent = 'Escolha seu avatar';
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'avatar-picker-close';
            close.setAttribute('aria-label', 'Fechar galeria de avatares');
            close.textContent = '×';
            close.addEventListener('click', () => avatarDialog.close());
            header.append(title, close);

            const description = document.createElement('p');
            description.textContent = 'Escolha um ícone para representar sua conta.';
            const gallery = document.createElement('div');
            gallery.className = 'avatar-picker-grid';
            gallery.setAttribute('role', 'group');
            gallery.setAttribute('aria-label', 'Avatares disponíveis');

            for (const option of avatarOptions) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'avatar-option';
                button.dataset.avatarId = option.id;
                button.setAttribute('aria-label', option.label);
                button.setAttribute('aria-pressed', 'false');
                const icon = document.createElement('span');
                icon.className = 'avatar-option-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = option.icon;
                const label = document.createElement('span');
                label.textContent = option.label;
                button.append(icon, label);
                button.addEventListener('click', () => saveAvatar(option.id, button));
                gallery.append(button);
            }

            avatarDialogStatus = document.createElement('p');
            avatarDialogStatus.className = 'avatar-picker-status';
            avatarDialogStatus.setAttribute('role', 'status');
            avatarDialogStatus.setAttribute('aria-live', 'polite');
            avatarDialog.append(header, description, gallery, avatarDialogStatus);
            document.body.append(avatarDialog);
            updateAvatarUI(selectedAvatar);
        }

        function openAvatarPicker() {
            if (!isAuthenticated) return;
            if (!avatarDialog) createAvatarDialog();
            avatarDialogStatus.textContent = '';
            avatarDialog.showModal();
        }

        async function saveAvatar(id, selectedButton) {
            if (selectedButton.disabled || id === selectedAvatar) {
                if (id === selectedAvatar) avatarDialog.close();
                return;
            }

            const buttons = [...avatarDialog.querySelectorAll('.avatar-option')];
            buttons.forEach((button) => { button.disabled = true; });
            avatarDialogStatus.textContent = 'Salvando avatar...';

            try {
                const { response, result } = await readApiJson(await apiFetch('/api/auth/avatar', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ avatar: id })
                }));
                if (!response.ok || result?.sucesso !== true || result.avatar !== id) {
                    throw new Error(apiErrorMessage(response, result, 'Não foi possível salvar o avatar.'));
                }

                updateAvatarUI(id);
                avatarDialog.close();
                const menuStatus = accountMenu.querySelector('.account-menu-status');
                if (menuStatus) menuStatus.textContent = 'Avatar atualizado.';
            } catch (error) {
                avatarDialogStatus.textContent = error.message || 'Não foi possível salvar o avatar.';
            } finally {
                buttons.forEach((button) => { button.disabled = false; });
            }
        }

        if (!avatarDialog) createAvatarDialog();

        if (profileLink) {
            accountToggle = document.createElement('button');
            accountToggle.type = 'button';
            accountToggle.className = 'account-toggle account-avatar-toggle';
            accountToggle.setAttribute('aria-label', 'Menu da conta');
            accountToggle.setAttribute('aria-haspopup', 'true');
            accountToggle.setAttribute('aria-controls', 'account-menu');
            accountToggle.append(makeAvatarSymbol('account-avatar avatar-symbol', selectedAvatar));

            profileLink.replaceWith(accountToggle);
        }

        if (accountToggle) {
            menuToggle = document.createElement('button');
            menuToggle.type = 'button';
            menuToggle.className = 'account-menu-toggle';
            menuToggle.setAttribute('aria-label', 'Abrir menu da conta');
            menuToggle.setAttribute('aria-expanded', 'false');
            menuToggle.setAttribute('aria-haspopup', 'true');
            menuToggle.setAttribute('aria-controls', 'account-menu');
            menuToggle.textContent = '⋯';
            accountContainer.append(menuToggle);

            accountMenu = document.createElement('div');
            accountMenu.id = 'account-menu';
            accountMenu.className = 'account-menu';
            accountMenu.hidden = true;
            accountContainer.append(accountMenu);

            const mobileUserCard = document.querySelector('.user-card-item');
            const mobileUserLink = mobileUserCard?.querySelector('.user-card-link');
            const mobileUserName = mobileUserCard?.querySelector('.user-name');
            const mobileAvatarImage = mobileUserCard?.querySelector('.user-avatar');
            let mobileAvatar = mobileAvatarImage;
            if (mobileAvatarImage) {
                mobileAvatar = makeAvatarSymbol('user-avatar user-avatar-symbol', selectedAvatar);
                mobileAvatar.setAttribute('role', 'img');
                mobileAvatarImage.replaceWith(mobileAvatar);
                mobileAvatar.addEventListener('click', (event) => {
                    if (!isAuthenticated) return;
                    event.preventDefault();
                    event.stopPropagation();
                    openAvatarPicker();
                });
                mobileAvatar.addEventListener('keydown', (event) => {
                    if (!isAuthenticated || !['Enter', ' '].includes(event.key)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    openAvatarPicker();
                });
            }
            let sessionRequest = null;

            function updateMobileUserCard(state, user) {
                if (!mobileUserLink || !mobileUserName) return;

                if (state === 'authenticated') {
                    mobileUserName.textContent = user.nome || 'Minha conta';
                    mobileUserLink.href = '/software/perfil/perfil.html';
                    if (mobileAvatar) {
                        mobileAvatar.setAttribute('role', 'button');
                        mobileAvatar.tabIndex = 0;
                        mobileAvatar.setAttribute(
                            'aria-label',
                            `Alterar avatar. Avatar atual: ${avatarOption(selectedAvatar).label}`
                        );
                    }
                } else if (state === 'visitor') {
                    mobileUserName.textContent = 'Entrar';
                    mobileUserLink.href = '/pages/login/login.html';
                    if (mobileAvatar) {
                        mobileAvatar.setAttribute('role', 'img');
                        mobileAvatar.tabIndex = -1;
                        mobileAvatar.setAttribute('aria-label', 'Avatar padrão: Pata');
                    }
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
                    const avatar = document.createElement('button');
                    const name = document.createElement('span');

                    identity.className = 'account-menu-user';
                    avatar.type = 'button';
                    avatar.className = 'account-menu-avatar-picker';
                    avatar.setAttribute('aria-label', `Alterar avatar. Avatar atual: ${avatarOption(selectedAvatar).label}`);
                    avatar.append(makeAvatarSymbol('account-menu-avatar-symbol', selectedAvatar));
                    avatar.addEventListener('click', openAvatarPicker);
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

                if (themeToggle) {
                    let label = themeToggle.querySelector('.theme-label');
                    if (!label) {
                        label = document.createElement('span');
                        label.className = 'theme-label';
                        themeToggle.append(label);
                    }
                    label.textContent = document.body.classList.contains('dark-mode')
                        ? 'Ativar tema claro'
                        : 'Ativar tema escuro';
                    accountMenu.append(themeToggle);
                }
            }

            function closeAccountMenu() {
                accountMenu.hidden = true;
                menuToggle.setAttribute('aria-expanded', 'false');
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
                    const { response, result } = await readApiJson(
                        await apiFetch('/api/auth/logout', { method: 'POST' })
                    );

                    if (!response.ok || result?.sucesso !== true) {
                        throw new Error(apiErrorMessage(response, result, 'Não foi possível encerrar a sessão.'));
                    }

                    renderAccountMenu('visitor', null);
                    isAuthenticated = false;
                    selectedAvatar = 'paw';
                    updateAvatarUI(selectedAvatar);
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
                        const { response, result } = await readApiJson(await apiFetch('/api/auth/sessao'));

                        if (!response.ok || typeof result?.autenticado !== 'boolean') {
                            throw new Error(apiErrorMessage(response, result, 'Não foi possível verificar a sessão.'));
                        }

                        if (result.autenticado) {
                            isAuthenticated = true;
                            updateAvatarUI(selectedAvatar);
                            const user = {
                                nome: typeof result.usuario?.nome === 'string'
                                    ? result.usuario.nome.trim()
                                    : ''
                            };
                            renderAccountMenu('authenticated', user);
                            updateMobileUserCard('authenticated', user);
                            try {
                                const { response: avatarResponse, result: avatarResult } = await readApiJson(
                                    await apiFetch('/api/auth/avatar')
                                );
                                if (avatarResponse.ok && avatarResult?.sucesso === true) {
                                    updateAvatarUI(avatarResult.avatar);
                                } else {
                                    const status = accountMenu.querySelector('.account-menu-status');
                                    if (status) {
                                        status.textContent = avatarResult?.mensagem
                                            || apiErrorMessage(
                                                avatarResponse,
                                                avatarResult,
                                                'Não foi possível carregar a preferência de avatar.'
                                            );
                                    }
                                }
                            } catch {
                                const status = accountMenu.querySelector('.account-menu-status');
                                if (status) status.textContent = 'Não foi possível carregar a preferência de avatar.';
                            }
                        } else {
                            isAuthenticated = false;
                            updateAvatarUI('paw');
                            renderAccountMenu('visitor', null);
                            updateMobileUserCard('visitor');
                        }
                    } catch (erro) {
                        isAuthenticated = false;
                        updateAvatarUI('paw');
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
                if (isAuthenticated) {
                    openAvatarPicker();
                    return;
                }
                const opening = accountMenu.hidden;
                accountMenu.hidden = !opening;
                menuToggle.setAttribute('aria-expanded', String(opening));
            });

            menuToggle.addEventListener('click', (event) => {
                event.stopPropagation();
                const opening = accountMenu.hidden;
                accountMenu.hidden = !opening;
                menuToggle.setAttribute('aria-expanded', String(opening));
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
                    menuToggle.focus();
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
                const { response: respostaCadastro, result: resultadoCadastro } = await readApiJson(
                    await apiFetch('/api/auth/cadastro', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(dados)
                    })
                );

                if (!respostaCadastro.ok || resultadoCadastro?.sucesso !== true) {
                    window.alert(apiErrorMessage(
                        respostaCadastro,
                        resultadoCadastro,
                        'Não foi possível realizar o cadastro.'
                    ));
                    return;
                }

                window.alert(resultadoCadastro.emailEnviado === true
                    ? 'Cadastro realizado e e-mail de boas-vindas enviado!'
                    : 'Cadastro realizado, mas nao foi possivel enviar o e-mail de boas-vindas.');

                const destino = cadastroForm.dataset.redirect;
                if (destino && destino !== '#') window.location.assign(destino);
            } catch (erro) {
                window.alert(erro.message || 'Nao foi possivel conectar ao servidor. Tente novamente.');
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
                const { response: resposta, result: resultado } = await readApiJson(await apiFetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(dados)
                }));

                if (!resposta.ok || resultado?.sucesso !== true) {
                    window.alert(apiErrorMessage(resposta, resultado, 'E-mail ou senha incorretos.'));
                    return;
                }

                const destino = loginForm.dataset.redirect;
                if (destino && destino !== '#') window.location.assign(destino);
                else if (accountToggle) await refreshAccount();
            } catch (erro) {
                window.alert(erro.message || 'Nao foi possivel conectar ao servidor. Tente novamente.');
            } finally {
                if (botao) botao.disabled = false;
            }
        });
    }
});