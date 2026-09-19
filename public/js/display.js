/**
 * İyilik Kumbarası - Display Module
 * Gösterim ekranı için dilek animasyonları, spotlight, ses ve konfeti
 */

class WishDisplay {
    constructor() {
        this.basePath = (window.__DEMO_BASE_PATH || '').replace(/\/+$/, '');
        this.isDemoMode = window.__DEMO_MODE === true || this.basePath === '/dilek';
        this.container = document.getElementById('wishes-container');
        this.emptyState = document.getElementById('empty-state');
        this.counterNumber = document.getElementById('counter-number');
        this.spotlightOverlay = document.getElementById('spotlight-overlay');
        this.spotlightLabel = document.getElementById('spotlight-label');
        this.spotlightName = document.getElementById('spotlight-name');
        this.displayQrPanel = document.getElementById('display-qr-panel');
        this.displayQrBox = document.getElementById('display-qr-box');

        this.wishes = [];
        this.wishCards = [];
        this.allServerWishes = []; // Tüm dilek havuzu eklendi
        this.pendingMessageWallWishes = [];
        this.wishRotationIndex = 0;
        this.socket = null;
        this.isMuted = false;
        this.audioCtx = null;
        this.displaySettings = { speedMultiplier: 1.0, scaleMultiplier: 1.0, messageWallEntranceStyle: 'standard', maxVisible: 20, logoOffsetPx: 0, headerOffsetPx: 0, logoScale: 1, headerScale: 1, dayMode: false, qrVisible: false, qrSize: 260, qrTop: 120, qrRight: 64 }; // Global ekran ayarları
        this.displayMode = 'balloon'; // 'balloon', 'lantern', 'star-lantern' veya 'messagewall'
        this.currentTheme = 'default';
        this._raffleAnimating = false; // Çekiliş animasyonu aktif mi

        this.init();
    }

    async init() {
        try {
            // Bu uc uc birbirinden bagimsiz, ama eskiden arka arkaya bekleniyordu:
            // perde ancak ucuncusu bitince kalkiyordu (olculen zincir ~735 ms).
            // Istekleri birlikte baslatiyoruz. UYGULAMA SIRASI DEGISMIYOR, cunku
            // applyTheme isMessageWallMode uzerinden displayMode'u okur; mod
            // yuklenmeden tema uygulanirsa mesaj duvari basligi yanlis kalir.
            const themeRequest = this.fetchJson('/api/theme');
            const settingsRequest = this.fetchJson('/api/display-settings');

            await this.loadDisplayMode();
            this.applyThemePayload(await themeRequest);
            this.applyDisplayMode();
            this.initDisplayQr();
            this.applyDisplaySettingsPayload(await settingsRequest);
            if (typeof window.finishDisplayBoot === 'function') {
                requestAnimationFrame(() => window.finishDisplayBoot());
            }
            this.connectSocket();
            this.bindEvents();
            this.initHeaderLogoObservers();
            this.startFloatingAnimation();
            this.setupAudio();
        } catch (e) {
            if (typeof window.finishDisplayBoot === 'function') {
                window.finishDisplayBoot();
            }
            console.error('WishDisplay init hatası:', e);
            // Retry after 2s — mobilde ilk yüklemede ağ gecikmesi olabilir
            setTimeout(() => {
                this.connectSocket();
                this.bindEvents();
                this.startFloatingAnimation();
                this.setupAudio();
            }, 2000);
        }
    }

    isMessageWallMode() {
        return this.displayMode === 'messagewall';
    }

    isStarLanternMode() {
        return this.displayMode === 'star-lantern';
    }

    isFloatingLanternMode() {
        return this.displayMode === 'lantern' || this.isStarLanternMode();
    }

    isEtnosporTheme() {
        return this.currentTheme === 'etnospor' || this.currentTheme === 'aselsan';
    }

    usesLandscapeCanvas() {
        return this.isDemoMode || this.isMessageWallMode() || this.isEtnosporTheme();
    }

    getCanvasSize() {
        if (this.isDemoMode) {
            return { width: 1920, height: 1080 };
        }
        if (this.isEtnosporTheme()) {
            return { width: 1344, height: 840 };
        }
        if (this.isMessageWallMode()) {
            return { width: 1920, height: 1080 };
        }
        return { width: 960, height: 2160 };
    }

    applyCanvasSize() {
        if (typeof window.setDisplayCanvasSize !== 'function') return;
        const size = this.getCanvasSize();
        window.setDisplayCanvasSize(size.width, size.height);
    }

    getVisibleWishLimit() {
        if (this.isMessageWallMode()) {
            return 5;
        }
        if (this.isFloatingLanternMode()) return this.getAdaptiveMaxVisible();
        return ((this.displaySettings && this.displaySettings.maxVisible) || 12);
    }

    getWishId(wishOrId) {
        if (wishOrId && typeof wishOrId === 'object') {
            return wishOrId.id === undefined || wishOrId.id === null ? null : String(wishOrId.id);
        }
        return wishOrId === undefined || wishOrId === null ? null : String(wishOrId);
    }

    syncOrderedWishRotation(pool = this.allServerWishes) {
        const size = Array.isArray(pool) ? pool.length : 0;
        if (size === 0) {
            this.wishRotationIndex = 0;
            return;
        }
        if (!Number.isFinite(this.wishRotationIndex)) {
            this.wishRotationIndex = 0;
        }
        this.wishRotationIndex = ((Math.floor(this.wishRotationIndex) % size) + size) % size;
    }

    upsertWishInUploadOrder(wish) {
        const wishId = this.getWishId(wish);
        if (!wishId) return;
        const existingIndex = this.allServerWishes.findIndex(existing => this.getWishId(existing) === wishId);
        if (existingIndex > -1) {
            this.allServerWishes[existingIndex] = wish;
        } else {
            this.allServerWishes.push(wish);
        }
        this.syncOrderedWishRotation();
    }

    recordWishShown() {
        // Ordered rotation advances when a wish is selected, not when it renders.
    }

    selectOrderedWish(pool = this.allServerWishes, options = {}) {
        if (!Array.isArray(pool) || pool.length === 0) return null;
        this.syncOrderedWishRotation(pool);

        const excluded = new Set([...(options.excludeIds || [])].map(id => String(id)));
        const currentWishId = this.getWishId(options.currentWishId);
        const allowExcludedFallback = options.allowExcludedFallback !== false;
        const startIndex = this.wishRotationIndex;

        for (let offset = 0; offset < pool.length; offset++) {
            const index = (startIndex + offset) % pool.length;
            const candidate = pool[index];
            const candidateId = this.getWishId(candidate);
            if (!candidateId || excluded.has(candidateId)) continue;
            this.wishRotationIndex = (index + 1) % pool.length;
            return candidate;
        }

        if (!allowExcludedFallback) return null;

        for (let offset = 0; offset < pool.length; offset++) {
            const index = (startIndex + offset) % pool.length;
            const candidate = pool[index];
            const candidateId = this.getWishId(candidate);
            if (!candidateId || (currentWishId && candidateId === currentWishId)) continue;
            this.wishRotationIndex = (index + 1) % pool.length;
            return candidate;
        }

        const fallback = pool[startIndex] || pool[0];
        this.wishRotationIndex = (startIndex + 1) % pool.length;
        return fallback;
    }

    selectOrderedWishes(count, options = {}) {
        const selected = [];
        const excluded = new Set([...(options.excludeIds || [])].map(id => String(id)));
        const pool = Array.isArray(options.pool) ? options.pool : this.allServerWishes;

        for (let i = 0; i < count; i++) {
            const nextWish = this.selectOrderedWish(pool, {
                excludeIds: excluded,
                allowExcludedFallback: false
            });
            if (!nextWish) break;
            selected.push(nextWish);
            const wishId = this.getWishId(nextWish);
            if (wishId) excluded.add(wishId);
        }

        return selected;
    }

    getVisibleWishes(pool) {
        if (!Array.isArray(pool) || pool.length === 0) return [];
        return this.selectOrderedWishes(this.getVisibleWishLimit(), { pool });
    }

    rebuildVisibleWishes(options = {}) {
        const { animateHighlightId = null } = options;
        this.container.querySelectorAll('.wish-card').forEach(card => card.remove());
        this.wishes = [];
        this.wishCards = [];
        this.pendingMessageWallWishes = [];

        const selected = this.getVisibleWishes(this.allServerWishes);
        selected.forEach((wish) => {
            const shouldAnimate = this.isMessageWallMode() ? true : String(animateHighlightId) === String(wish.id);
            this.addWish(wish, shouldAnimate);
        });

        this.emptyState.style.display = selected.length ? 'none' : '';
    }

    applyDisplayMode() {
        const messageWall = this.isMessageWallMode();
        document.documentElement.classList.toggle('display-mode-messagewall', messageWall);
        document.documentElement.classList.toggle('display-mode-star-lantern', this.isStarLanternMode());
        this.applyCanvasSize();

        const legacyTitle = document.querySelector('.header-line2');
        if (legacyTitle) {
            legacyTitle.textContent = 'DİLEK FENERİ';
        }

        const stageTitle = document.querySelector('.message-stage__headline-text');
        if (stageTitle) {
            stageTitle.textContent = 'PEKİ SENİN DİLEĞİN NE?';
        }

        const stagePrefix = document.querySelector('.message-stage__headline-prefix');
        if (stagePrefix) {
            stagePrefix.textContent = 'DİLEKLER GELENEĞİN GELECEĞİ İÇİN';
        }

        const emptyText = document.querySelector('#empty-state .empty-text');
        const emptySub = document.querySelector('#empty-state .empty-sub');
        if (emptyText) emptyText.textContent = 'Dilekler bekleniyor...';
        if (emptySub) emptySub.textContent = 'İlk dilek paylaşıldığında burada görünecek';
    }

    // === AUDIO ===
    setupAudio() {
        // AudioContext'i kullanici etkilesiminde olustur (autoplay policy)
        const createCtx = () => {
            if (!this.audioCtx) {
                this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            document.removeEventListener('click', createCtx);
        };
        document.addEventListener('click', createCtx);
    }

    playSound(type) {
        if (this.isMuted || !this.audioCtx) return;
        try {
            const ctx = this.audioCtx;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            if (type === 'newWish') {
                // Mutlu "ding" sesi
                osc.type = 'sine';
                osc.frequency.setValueAtTime(880, ctx.currentTime);
                osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
                osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.2);
                gain.gain.setValueAtTime(0.3, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.5);
            } else if (type === 'spotlight') {
                // Buyulu spotlight sesi
                osc.type = 'sine';
                osc.frequency.setValueAtTime(440, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3);
                osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.6);
                gain.gain.setValueAtTime(0.2, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.8);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.8);
            }
        } catch (e) {
            // Ses calmazsa sessizce devam et
        }
    }

    // === CONFETTI ===
    fireConfetti(amount = 50, mode = 'top') {
        const colors = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#A8E6CF', '#FF8E8E', '#FF69B4', '#7B68EE', '#00CED1', '#FF4500', '#FFD700'];

        for (let i = 0; i < amount; i++) {
            const conf = document.createElement('div');
            const w = 6 + Math.random() * 16;
            const h = Math.random() > 0.5 ? w : w * (1.5 + Math.random());
            conf.className = 'display-confetti' + (mode === 'left' ? ' side-left' : mode === 'right' ? ' side-right' : '');
            if (mode === 'top') {
                conf.style.left = (Math.random() * 1920) + 'px';
                conf.style.top = '-40px';
            } else if (mode === 'left') {
                conf.style.left = '-60px';
                conf.style.top = (800 + Math.random() * 2500) + 'px';
            } else if (mode === 'right') {
                conf.style.left = (1920 + 60) + 'px';
                conf.style.top = (800 + Math.random() * 2500) + 'px';
            }
            conf.style.width = w + 'px';
            conf.style.height = h + 'px';
            conf.style.borderRadius = Math.random() > 0.4 ? '3px' : '50%';
            conf.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            conf.style.animationDelay = Math.random() * 2.5 + 's';
            conf.style.animationDuration = (Math.random() * 2 + 2.5) + 's';

            document.querySelector('.display-container').appendChild(conf);
            setTimeout(() => { if (conf && conf.parentNode) conf.remove(); }, 7000);
        }
    }

    // === RAFFLE ANIMATION (3-2-1 Countdown → Name Reveal) ===
    showRaffleAnimation(winners) {
        const overlay = document.getElementById('raffle-overlay');
        const container = document.getElementById('raffle-winners-container');

        if (!overlay || !container || !winners || winners.length === 0) {
            console.log('🎁 Raffle ABORT: overlay=', !!overlay, 'container=', !!container, 'winners=', winners);
            return;
        }

        // Önceki sonuçları temizle
        container.innerHTML = '';

        // Animasyon aktif işaretle
        this._raffleAnimating = true;
        console.log('🎁 Raffle overlay SHOW — animasyon başlıyor');

        // Modal'ı göster
        overlay.classList.add('show');

        // Geri sayım elemanı oluştur
        const countdownEl = document.createElement('div');
        countdownEl.className = 'raffle-countdown';
        countdownEl.textContent = '3';
        container.appendChild(countdownEl);

        // 3-2-1 Geri Sayım
        let count = 3;
        const countInterval = setInterval(() => {
            count--;
            if (count > 0) {
                countdownEl.textContent = count;
                countdownEl.classList.remove('countdown-pop');
                void countdownEl.offsetWidth; // Force reflow
                countdownEl.classList.add('countdown-pop');
            } else {
                clearInterval(countInterval);
                // Geri sayım bitti — ismi göster
                countdownEl.remove();

                winners.forEach((w) => {
                    const item = document.createElement('div');
                    item.className = 'raffle-item';
                    const wishHtml = w.wishText ? `<div style="font-size:26px; color:rgba(255,255,255,0.85); margin-top:15px; font-style:italic; line-height:1.4; max-width:800px;">"${w.wishText}"</div>` : '';
                    item.innerHTML = `<div style="font-size:28px; color:rgba(255,255,255,0.9); margin-bottom:15px;">\u2728 Sıradaki Talihli! \u2728</div>
                                      <div style="color:#FFD700; font-size:64px; font-weight:900; text-shadow:0 0 30px rgba(255,215,0,0.6);">${w.childName}</div>${wishHtml}`;
                    container.appendChild(item);

                    // İsim reveal animasyonu
                    setTimeout(() => {
                        this.playSound('spotlight');
                        item.classList.add('reveal');

                        // Raffle box golden pulse
                        const raffleBox = overlay.querySelector('.raffle-box');
                        if (raffleBox) raffleBox.classList.add('celebrating');

                        // Büyük kutlama — konfeti patlaması + havai fişek + sparkles
                        this.fireConfetti(80, 'top');
                        this.fireConfetti(50, 'left');
                        this.fireConfetti(50, 'right');
                        this.fireGoldenSparkles();
                        this.fireEmojiRain();
                        this.fireFirework(30, 30);
                        this.fireFirework(70, 25);
                        this.fireFirework(50, 40);
                        // 2. dalga — 1.5 saniye sonra
                        setTimeout(() => {
                            this.fireConfetti(60, 'top');
                            this.fireFirework(20, 35);
                            this.fireFirework(80, 30);
                        }, 1500);
                    }, 200);
                });
            }
            // Animasyon tamamlandı
            this._raffleAnimating = false;
            console.log('🎁 Raffle animasyon tamamlandı');
        }, 1000);

        // İlk pop animasyonu
        countdownEl.classList.add('countdown-pop');
    }

    // === GOLDEN SPARKLES (Çekiliş kutlama efekti) ===
    fireGoldenSparkles() {
        const colors = ['#FFD700', '#FFA500', '#FFEC8B', '#FFE4B5', '#FFFFFF'];
        for (let i = 0; i < 75; i++) {
            const spark = document.createElement('div');
            const rx = Math.random();
            const ry = Math.random();
            spark.style.cssText = `
                position: absolute;
                width: ${4 + Math.random() * 10}px;
                height: ${4 + Math.random() * 10}px;
                background: ${colors[Math.floor(Math.random() * colors.length)]};
                border-radius: 50%;
                z-index: 10001;
                pointer-events: none;
                left: ${25 + Math.random() * 50}%;
                top: ${15 + Math.random() * 50}%;
                --rx: ${rx};
                --ry: ${ry};
                animation: sparkleExplode ${1.5 + Math.random() * 2.5}s ease-out forwards;
                animation-delay: ${Math.random() * 2.5}s;
                opacity: 0;
                box-shadow: 0 0 ${8 + Math.random() * 14}px ${colors[Math.floor(Math.random() * colors.length)]};
            `;
            document.querySelector('.display-container').appendChild(spark);
            setTimeout(() => { if (spark.parentNode) spark.remove(); }, 7000);
        }
    }

    // === FIREWORK STARBURST ===
    fireFirework(x, y) {
        const rayCount = 24 + Math.floor(Math.random() * 12);
        const burstColors = ['#FFD700', '#FF6B6B', '#4ECDC4', '#FF69B4', '#FFA500', '#7B68EE', '#FFFFFF'];
        const color = burstColors[Math.floor(Math.random() * burstColors.length)];
        for (let i = 0; i < rayCount; i++) {
            const ray = document.createElement('div');
            ray.className = 'firework-ray';
            const angle = (360 / rayCount) * i;
            const len = 80 + Math.random() * 80;
            ray.style.cssText = `
                left: ${x}%;
                top: ${y}%;
                height: 0;
                width: ${3 + Math.random() * 3}px;
                background: linear-gradient(to top, ${color}, transparent);
                transform: rotate(${angle}deg);
                animation-duration: ${1.2 + Math.random() * 0.8}s;
                animation-delay: ${Math.random() * 0.3}s;
            `;
            document.querySelector('.display-container').appendChild(ray);
            setTimeout(() => { if (ray.parentNode) ray.remove(); }, 4000);
        }
    }

    // === EMOJI RAIN ===
    fireEmojiRain() {
        const emojis = ['🎉', '🎊', '⭐', '🌟', '✨', '💫', '🎁', '🏆', '💖', '🎈', '🥳', '🎆'];
        for (let i = 0; i < 18; i++) {
            const em = document.createElement('div');
            em.className = 'celebration-emoji';
            em.textContent = emojis[Math.floor(Math.random() * emojis.length)];
            em.style.left = (Math.random() * 1800) + 'px';
            em.style.top = '-80px';
            em.style.fontSize = (40 + Math.random() * 50) + 'px';
            em.style.animationDelay = Math.random() * 3 + 's';
            em.style.animationDuration = (3 + Math.random() * 2) + 's';
            document.querySelector('.display-container').appendChild(em);
            setTimeout(() => { if (em.parentNode) em.remove(); }, 8000);
        }
    }

    // === FLASH EFFECT ===
    fireFlash() {
        const flash = document.createElement('div');
        flash.className = 'reveal-flash';
        document.querySelector('.display-container').appendChild(flash);
        setTimeout(() => { if (flash.parentNode) flash.remove(); }, 1000);
    }

    // === SOCKET ===
    connectSocket() {
        this.socket = io({ path: `${this.basePath}/socket.io` });

        this.socket.on('all-wishes', (serverWishes) => {
            console.log('📥 Mevcut dilekler:', serverWishes.length);
            this.totalWishesCount = serverWishes.length;
            this.allServerWishes = [...serverWishes];
            this.wishRotationIndex = 0;
            this.syncOrderedWishRotation();
            this.rebuildVisibleWishes();
            this.updateCounter();
        });

        this.socket.on('new-wish', (wish) => {
            console.log('🎈 Yeni dilek:', wish.childName);
            const wishId = String(wish.id);
            const alreadyKnown = this.allServerWishes.some(existing => String(existing.id) === wishId);
            if (!alreadyKnown && this.totalWishesCount !== undefined) {
                this.totalWishesCount++;
            }
            this.upsertWishInUploadOrder(wish);
            if (this.isMessageWallMode() && this.wishCards.length >= this.getVisibleWishLimit()) {
                this.showMessageWallWishImmediately(wish);
            } else {
                this.addWish(wish, true);
            }
            this.updateCounter();
            this.showNewWishToast(wish.childName);
            this.playSound('newWish');
            this.fireConfetti();
        });

        this.socket.on('spotlight', (wish) => {
            console.log('🌟 Spotlight:', wish.childName);
            this.showSpotlight(wish);
            this.playSound('spotlight');
        });

        this.socket.on('spotlight-off', () => {
            this.hideSpotlight();
        });

        this.socket.on('wish-deleted', (data) => {
            console.log('🗑️ Dilek silindi:', data.id);
            if (this.totalWishesCount !== undefined) {
                this.totalWishesCount = Math.max(0, this.totalWishesCount - 1);
            }
            this.allServerWishes = this.allServerWishes.filter(w => String(w.id) !== String(data.id));
            this.syncOrderedWishRotation();
            this.removeWish(data.id);
            this.updateCounter();
        });

        this.socket.on('wish-updated', (wish) => {
            console.log('✏️ Dilek guncellendi:', wish.childName);
            const poolIndex = this.allServerWishes.findIndex(w => String(w.id) === String(wish.id));
            if (poolIndex > -1) {
                this.allServerWishes[poolIndex] = wish;
            }

            const cardData = this.wishCards.find(c => c.element.dataset.wishId === wish.id);
            if (cardData && cardData.element) {
                if (cardData.isMessageWall) {
                    this.applyMessageWallContent(cardData.element, wish);
                } else {
                    const renderedText = wish.wishText
                        ? (wish.wishText.length > 180 ? wish.wishText.substring(0, 180) + '…' : wish.wishText).replace(/\n/g, '<br>')
                        : '';
                    const messageShell = cardData.element.querySelector('.message-card-shell');
                    if (messageShell) {
                        messageShell.innerHTML = `
                            ${renderedText ? `<div class="wish-text">${renderedText}</div>` : '<div class="wish-text">Dilek metni bekleniyor.</div>'}
                            <div class="child-name">${wish.childName}</div>
                        `;
                        this.fitMessageWallTypography(cardData.element);
                    } else {
                        // Balonu yeni verilerle güncelle
                        const body = cardData.element.querySelector('.balloon-body') || cardData.element.querySelector('.lantern-text');
                        if (body) {
                            const textHtml = wish.wishText ? '<div class="wish-text">' + wish.wishText.replace(/\\n/g, '<br>') + '</div>' : '';
                            body.innerHTML = textHtml + '<div class="child-name">' + wish.childName + '</div>';
                            this.fitFloatingCardTypography(cardData.element);
                            requestAnimationFrame(() => this.fitFloatingCardTypography(cardData.element));
                        }
                    }
                }
            }

            // Dizi içindeki orjinal veriyi de güncelle (spotlight için gerekli)
            const idx = this.wishes.findIndex(w => String(w.id) === String(wish.id));
            if (idx !== -1) {
                this.wishes[idx] = wish;
            }

            // Eğer o an bu dilek Spotlight modundaysa, spotlight penceresindeki yazıyı da güncelle
            if (this.spotlightOverlay.classList.contains('show') &&
                this.spotlightWishText &&
                idx !== -1 &&
                this.wishes[idx].isSpotlight) {
                this.spotlightWishText.textContent = wish.wishText || '';
            }
        });

        this.socket.on('all-cleared', () => {
            console.log('🗑️ Tüm dilekler silindi');
            this.totalWishesCount = 0;
            this.allServerWishes = [];
            this.wishRotationIndex = 0;
            this.clearAll();
        });

        // === RAFFLE (ÇEKİLİŞ) SOCKET OLAYLARI ===
        this.socket.on('raffle-winners', (winners) => {
            console.log('🎁 Çekiliş Sonuçları Geldi!', winners);
            this.showRaffleAnimation(winners);
        });

        this.socket.on('raffle-close', () => {
            // Animasyon devam ediyorsa close'u yoksay
            if (this._raffleAnimating) {
                console.log('🎁 Çekiliş CLOSE yoksayıldı — animasyon devam ediyor');
                return;
            }
            console.log('🎁 Çekiliş Ekranı Kapatıldı');
            const overlay = document.getElementById('raffle-overlay');
            if (overlay) overlay.classList.remove('show');
        });

        this.socket.on('theme-change', (theme) => {
            console.log('🎨 Tema değişti:', theme);
            this.applyTheme(theme);
        });

        // EKRAN AYARLARI SOCKET
        this.socket.on('display-settings', (settings) => {
            console.log('📺 Ekran Ayarları Geldi:', settings);
            this.displaySettings = { ...this.displaySettings, ...settings };
            this.applyDisplaySettings();
        });

        this.socket.on('display-mode-change', (mode) => {
            console.log('🎭 Gösterim modu değişti:', mode);
            this.displayMode = mode;
            this.applyDisplayMode();
            this.rebuildVisibleWishes();
            this.updateCounter();
        });
    }

    // === AYARLARI UYGULA ===
    applyDisplaySettings() {
        const scale = this.displaySettings.scaleMultiplier || 1.0;
        const speed = this.displaySettings.speedMultiplier || 1.0;
        const maxVisible = this.getVisibleWishLimit();
        const logoOffsetPx = typeof this.displaySettings.logoOffsetPx === 'number' ? this.displaySettings.logoOffsetPx : 0;
        const headerOffsetPx = typeof this.displaySettings.headerOffsetPx === 'number' ? this.displaySettings.headerOffsetPx : 0;
        const logoScale = typeof this.displaySettings.logoScale === 'number' ? this.displaySettings.logoScale : 1;
        const headerScale = typeof this.displaySettings.headerScale === 'number' ? this.displaySettings.headerScale : 1;
        const qrVisible = !!this.displaySettings.qrVisible;
        const qrSize = typeof this.displaySettings.qrSize === 'number' ? this.displaySettings.qrSize : 220;
        const rawQrTop = typeof this.displaySettings.qrTop === 'number' ? this.displaySettings.qrTop : 160;
        const rawQrRight = typeof this.displaySettings.qrRight === 'number' ? this.displaySettings.qrRight : 80;
        const safeQrPlacement = this.getSafeQrPlacement(qrSize, rawQrTop, rawQrRight);
        console.log(`📺 Ayarlar uygulanıyor: Hız=${speed}x, Ölçek=${scale}x, Max=${maxVisible}`);

        // screenMode artık otomatik — her ekran kendi aspect ratio'suna göre ayarlanıyor

        // CSS değişkenini ayarla (transform'da kullanılıyor)
        document.documentElement.style.setProperty('--card-scale', scale);
        document.documentElement.style.setProperty('--logo-offset', `${logoOffsetPx}px`);
        document.documentElement.style.setProperty('--header-offset', `${headerOffsetPx}px`);
        document.documentElement.style.setProperty('--logo-scale', logoScale.toString());
        document.documentElement.style.setProperty('--header-scale', headerScale.toString());
        document.documentElement.style.setProperty('--qr-size', `${safeQrPlacement.size}px`);
        document.documentElement.style.setProperty('--qr-top', `${safeQrPlacement.top}px`);
        document.documentElement.style.setProperty('--qr-right', `${safeQrPlacement.right}px`);
        document.documentElement.style.setProperty('--qr-panel-scale', safeQrPlacement.scale.toString());

        // Ayrı logo boyutları
        const bakanlikScale = typeof this.displaySettings.bakanlikScale === 'number' ? this.displaySettings.bakanlikScale : 1;
        const akmScale = typeof this.displaySettings.akmScale === 'number' ? this.displaySettings.akmScale : 1;
        document.documentElement.style.setProperty('--bakanlik-scale', bakanlikScale.toString());
        document.documentElement.style.setProperty('--akm-scale', akmScale.toString());

        // Ayrı logo X/Y pozisyon (piksel)
        const bakanlikX = typeof this.displaySettings.bakanlikX === 'number' ? this.displaySettings.bakanlikX : 0;
        const bakanlikY = typeof this.displaySettings.bakanlikY === 'number' ? this.displaySettings.bakanlikY : 0;
        const akmX = typeof this.displaySettings.akmX === 'number' ? this.displaySettings.akmX : 0;
        const akmY = typeof this.displaySettings.akmY === 'number' ? this.displaySettings.akmY : 0;
        document.documentElement.style.setProperty('--bakanlik-x', `${bakanlikX}px`);
        document.documentElement.style.setProperty('--bakanlik-y', `${bakanlikY}px`);
        document.documentElement.style.setProperty('--akm-x', `${akmX}px`);
        document.documentElement.style.setProperty('--akm-y', `${akmY}px`);

        // Logo X/Y pozisyon (piksel)
        const logoTopX = typeof this.displaySettings.logoTopX === 'number' ? this.displaySettings.logoTopX : 0;
        const logoTopY = typeof this.displaySettings.logoTopY === 'number' ? this.displaySettings.logoTopY : 0;
        document.documentElement.style.setProperty('--logo-top-x', `${logoTopX}px`);
        document.documentElement.style.setProperty('--logo-top-y', `${logoTopY}px`);

        // Başlık X/Y pozisyon (piksel)
        const headerX = typeof this.displaySettings.headerX === 'number' ? this.displaySettings.headerX : 0;
        const headerY = typeof this.displaySettings.headerY === 'number' ? this.displaySettings.headerY : 0;
        document.documentElement.style.setProperty('--header-x', `${headerX}px`);
        document.documentElement.style.setProperty('--header-y', `${headerY}px`);

        // Gündüz modu sınıfı
        document.documentElement.classList.toggle('day-mode', !!this.displaySettings.dayMode);
        if (this.displayQrPanel) {
            this.displayQrPanel.classList.toggle('visible', qrVisible);
            this.alignDisplayQrPanelToStage(safeQrPlacement);
        }

        // Logo ve başlık çakışmasını önle (ekranlar arası ölçek farkı)
        this.updateHeaderLogoSpacing();
        requestAnimationFrame(() => this.updateHeaderLogoSpacing());

        // Mevcut tüm kartlara ölçeği anında uygula
        this.wishCards.forEach(cardData => {
            const depthScale = this.isFloatingLanternMode() ? scale * (cardData.zDepth || 1) : scale;
            cardData.element.style.transform = `translate3d(${cardData.x}px, ${cardData.y}px, 0) scale(${depthScale}) rotate(${cardData.rotation}deg)`;
        });

        // maxVisible değiştiğinde: fazla kartları sil veya eksik kartları ekle
        if (this.wishCards.length > maxVisible) {
            // Fazla kartları sil
            while (this.wishCards.length > maxVisible) {
                const removed = this.wishCards.shift();
                if (removed && removed.element) {
                    const wishId = removed.element.dataset.wishId;
                    this.wishes = this.wishes.filter(w => w.id !== wishId);
                    removed.element.style.transition = 'opacity 0.5s ease';
                    removed.element.style.opacity = '0';
                    setTimeout(() => { if (removed.element.parentNode) removed.element.remove(); }, 500);
                }
            }
        } else if (this.wishCards.length < maxVisible && this.allServerWishes && this.allServerWishes.length > 0) {
            // Eksik kartları havuzdan ekle
            const currentIds = new Set(this.wishes.map(w => String(w.id)));
            const toAdd = this.selectOrderedWishes(maxVisible - this.wishCards.length, { excludeIds: currentIds });
            toAdd.forEach(wish => {
                this.addWish(wish, false);
            });
        }
    }

    updateHeaderLogoSpacing() {
        const logoBar = document.querySelector('.logos-top-bar');
        const headerBox = document.querySelector('.header-title-box');
        if (!logoBar || !headerBox) return;

        const gap = 16;
        const logoRect = logoBar.getBoundingClientRect();
        const headerRect = headerBox.getBoundingClientRect();
        const overlap = (logoRect.bottom + gap) - headerRect.top;
        const safeOffset = overlap > 0 ? -Math.ceil(overlap) : 0;

        document.documentElement.style.setProperty('--header-safe-offset', `${safeOffset}px`);
    }

    initHeaderLogoObservers() {
        const logoBar = document.querySelector('.logos-top-bar');
        const headerBox = document.querySelector('.header-title-box');
        if (!logoBar || !headerBox) return;

        const schedule = () => {
            this.updateHeaderLogoSpacing();
            requestAnimationFrame(() => this.updateHeaderLogoSpacing());
        };

        if (this._headerLogoObserver) {
            this._headerLogoObserver.disconnect();
        }

        if (typeof ResizeObserver !== 'undefined') {
            this._headerLogoObserver = new ResizeObserver(() => schedule());
            this._headerLogoObserver.observe(logoBar);
            this._headerLogoObserver.observe(headerBox);
        }

        const logoImg = logoBar.querySelector('img');
        if (logoImg && !logoImg.complete) {
            logoImg.addEventListener('load', schedule, { once: true });
        }

        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(schedule).catch(() => { });
        }

        window.addEventListener('load', schedule, { once: true });
    }

    // === EVENTS ===
    bindEvents() {
        // Spotlight overlay'e tıklayınca kapat
        this.spotlightOverlay.addEventListener('click', () => {
            this.hideSpotlight();
        });

        // Pencere boyutu değişince pozisyonları güncelle (Y sınırlandırması kaldırıldı)
        window.addEventListener('resize', () => {
            // Balonlar yeni algoritmada tamamen özgür aktığı için resize sırasında 
            // balonların yerini zorla sınırlandırmaya gerek yoktur.
            this.updateHeaderLogoSpacing();
            this.applyDisplaySettings();
        });

        const resyncFullscreenLayout = () => {
            if (typeof scaleToFit === 'function') {
                scaleToFit();
                requestAnimationFrame(() => scaleToFit());
                window.setTimeout(() => scaleToFit(), 80);
                window.setTimeout(() => scaleToFit(), 220);
            }
            this.updateHeaderLogoSpacing();
        };

        // Fullscreen
        const fsBtn = document.getElementById('fullscreen-btn');
        if (fsBtn) {
            fsBtn.addEventListener('click', async () => {
                if (!document.fullscreenElement) {
                    try {
                        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
                    } catch (_) {
                        try {
                            await document.documentElement.requestFullscreen();
                        } catch (_) { }
                    }
                } else {
                    document.exitFullscreen().catch(() => { });
                }
                resyncFullscreenLayout();
            });
        }

        document.addEventListener('fullscreenchange', () => {
            const fsBtn = document.getElementById('fullscreen-btn');
            if (fsBtn) {
                fsBtn.innerHTML = '&#x26F6;';
                fsBtn.title = 'Tam ekran';
                fsBtn.setAttribute('aria-label', 'Tam ekran');
            }
            document.documentElement.classList.toggle('display-fullscreen', !!document.fullscreenElement);
            resyncFullscreenLayout();
        });

        // Mute toggle
        const muteBtn = document.getElementById('mute-btn');
        if (muteBtn) {
            muteBtn.addEventListener('click', () => {
                this.isMuted = !this.isMuted;
                muteBtn.textContent = this.isMuted ? '🔇' : '🔊';
                muteBtn.classList.toggle('muted', this.isMuted);
            });
        }
    }

    // === WISH CARDS ===
    getAdaptiveMaxVisible() {
        const cw = this.container.offsetWidth || 960;
        const ch = this.container.offsetHeight || 2160;
        const isStarLantern = this.isStarLanternMode();
        const cardWidth = isStarLantern ? 340 : 320;
        const cardHeight = isStarLantern ? 560 : 400;
        const scale = this.displaySettings.scaleMultiplier || 1.0;
        const columnFactor = isStarLantern ? 0.5 : 0.62;
        const rowFactor = isStarLantern ? 0.42 : 0.46;
        const columns = Math.max(1, Math.floor(cw / (cardWidth * scale * columnFactor)));
        const rows = Math.max(1, Math.floor(ch / (cardHeight * scale * rowFactor)));
        const maxAllowed = Math.max(2, columns * rows);
        const adminMax = (this.displaySettings && this.displaySettings.maxVisible) || 20;
        return Math.max(2, Math.min(adminMax, maxAllowed));
    }

    getQrStageMetrics() {
        const stage = document.getElementById('scaled-app') || this.container;
        const rect = stage ? stage.getBoundingClientRect() : {
            left: 0,
            top: 0,
            right: window.innerWidth || 960,
            width: window.innerWidth || 960,
            height: window.innerHeight || 2160
        };
        const rootStyle = getComputedStyle(document.documentElement);
        const designWidth = parseFloat(rootStyle.getPropertyValue('--design-width-num')) || this.container?.offsetWidth || 960;
        const designHeight = parseFloat(rootStyle.getPropertyValue('--design-height-num')) || this.container?.offsetHeight || 2160;
        const scaleX = rect.width > 0 && designWidth > 0 ? rect.width / designWidth : 1;
        const scaleY = rect.height > 0 && designHeight > 0 ? rect.height / designHeight : scaleX;
        const scale = Math.min(scaleX, scaleY);

        return {
            left: rect.left || 0,
            top: rect.top || 0,
            right: Number.isFinite(rect.right) ? rect.right : (rect.left || 0) + (rect.width || designWidth),
            width: rect.width || designWidth,
            height: rect.height || designHeight,
            designWidth,
            designHeight,
            scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
            scaleX: Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1,
            scaleY: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : 1
        };
    }

    getQrPanelExtraHeight(qrSize) {
        return qrSize <= 130 ? 100 : 68;
    }

    getSafeQrPlacement(qrSize, qrTop, qrRight) {
        const stage = this.getQrStageMetrics();
        const designWidth = stage.designWidth;
        const designHeight = stage.designHeight;
        const panelHeight = qrSize + this.getQrPanelExtraHeight(qrSize);
        const minGap = 24;
        const bottomGap = 0;
        const maxTop = Math.max(minGap, designHeight - panelHeight - bottomGap);
        const maxRight = Math.max(minGap, designWidth - qrSize - 32);
        const safeTop = Math.max(minGap, Math.min(qrTop, maxTop));
        const safeRight = Math.max(minGap, Math.min(qrRight, maxRight));
        const scaledSize = qrSize * stage.scale;

        return {
            top: stage.top + (safeTop * stage.scaleY),
            right: Math.max(0, (window.innerWidth || stage.right) - (stage.right - (safeRight * stage.scaleX))),
            size: Math.max(60, scaledSize),
            scale: stage.scale,
            safeTop,
            maxTop,
            designPanelHeight: panelHeight
        };
    }

    alignDisplayQrPanelToStage(placement) {
        if (!this.displayQrPanel || !placement) return;
        if (!this.displayQrPanel.classList.contains('visible')) return;
        if (Math.abs(placement.safeTop - placement.maxTop) > 0.5) return;

        const stage = this.getQrStageMetrics();
        const panelRect = this.displayQrPanel.getBoundingClientRect();
        if (!panelRect.height || !stage.scale) return;

        const actualPanelHeight = panelRect.height / stage.scale;
        const bottomCompensation = Math.max(0, placement.designPanelHeight - actualPanelHeight);
        if (bottomCompensation <= 0) return;

        const maxPixelTop = stage.top + stage.height - panelRect.height;
        const adjustedTop = Math.min(maxPixelTop, placement.top + (bottomCompensation * stage.scale));
        document.documentElement.style.setProperty('--qr-top', `${Math.max(stage.top, adjustedTop)}px`);
    }

    initDisplayQr() {
        if (!this.displayQrPanel || !this.displayQrBox) return;
        if (this.displayQrPanel.parentElement !== document.body) {
            document.body.appendChild(this.displayQrPanel);
        }
        const uploadUrl = `${window.location.origin}${this.basePath}/upload`;
        this.displayQrBox.innerHTML = '';
        const img = document.createElement('img');
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=520x520&margin=12&data=${encodeURIComponent(uploadUrl)}`;
        img.alt = 'Katılım QR kodu';
        img.dataset.qrUrl = uploadUrl;
        this.displayQrBox.appendChild(img);
    }

    getMessageWallSlots() {
        const cw = this.container.offsetWidth || DESIGN_WIDTH;
        const ch = this.container.offsetHeight || DESIGN_HEIGHT;
        const scaleX = cw / 1920;
        const scaleY = ch / 1080;
        const baseSlots = [
            { key: 'hero', className: 'messagewall-slot--hero', variant: 'large', x: 789, y: 565, width: 344, height: 386, zIndex: 46, delay: 120 },
            { key: 'left-high', className: 'messagewall-slot--small', variant: 'small', x: 509, y: 445, width: 225, height: 252, zIndex: 42, delay: 260 },
            { key: 'right-high', className: 'messagewall-slot--small', variant: 'small', x: 1186, y: 445, width: 225, height: 252, zIndex: 42, delay: 360 },
            { key: 'left-low', className: 'messagewall-slot--small', variant: 'small', x: 229, y: 574, width: 225, height: 252, zIndex: 41, delay: 460 },
            { key: 'right-low', className: 'messagewall-slot--small', variant: 'small', x: 1465, y: 574, width: 225, height: 252, zIndex: 41, delay: 560 }
        ];

        return baseSlots.map((slot) => ({
            ...slot,
            x: Math.round(slot.x * scaleX),
            y: Math.round(slot.y * scaleY),
            width: Math.round(slot.width * scaleX),
            height: Math.round(slot.height * scaleY)
        }));
    }

    getMessageWallSlotByKey(key) {
        return this.getMessageWallSlots().find(slot => slot.key === key) || null;
    }

    getNextMessageWallSlot() {
        const occupied = new Set(
            this.wishCards
                .filter(card => card.isMessageWall)
                .map(card => card.slotKey)
        );
        return this.getMessageWallSlots().find(slot => !occupied.has(slot.key)) || null;
    }

    formatWishHtml(text) {
        if (!text) return '';
        const truncated = text.length > 180 ? text.substring(0, 180) + '…' : text;
        return truncated.replace(/\n/g, '<br>');
    }

    formatMessageWallHtml(text) {
        if (!text) return '';
        const normalized = text
            .replace(/\s*\n+\s*/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const truncated = normalized.length > 180 ? normalized.substring(0, 180) + '…' : normalized;
        return truncated;
    }

    formatFloatingWishHtml(text, maxLength = 140) {
        if (!text) return '';
        const truncated = text.length > maxLength ? text.substring(0, maxLength) + '…' : text;
        return truncated.replace(/\n/g, '<br>');
    }

    applyFloatingWishContent(cardData, wish, maxLength = 140) {
        if (!cardData || !cardData.element || !wish) return;
        const oldWishId = this.getWishId(cardData.element.dataset.wishId);
        const wishId = this.getWishId(wish);

        if (wishId) {
            cardData.element.dataset.wishId = wishId;
        }

        const oldIndex = this.wishes.findIndex(item => this.getWishId(item) === oldWishId);
        if (oldIndex > -1) {
            this.wishes[oldIndex] = wish;
        } else if (!this.wishes.some(item => this.getWishId(item) === wishId)) {
            this.wishes.push(wish);
        }

        const textEl = cardData.element.querySelector('.wish-text');
        const nameEl = cardData.element.querySelector('.child-name');
        if (textEl) {
            textEl.innerHTML = wish.wishText ? this.formatFloatingWishHtml(wish.wishText, maxLength) : '';
        }
        if (nameEl) {
            nameEl.textContent = wish.childName || '';
        }
        this.recordWishShown(wish);
    }

    queueMessageWallWish(wish) {
        if (!wish || wish.id === undefined || wish.id === null) return;
        const wishId = String(wish.id);
        const alreadyVisible = this.wishCards.some(card => String(card.element.dataset.wishId) === wishId);
        const alreadyQueued = this.pendingMessageWallWishes.some(item => String(item.id) === wishId);
        if (!alreadyVisible && !alreadyQueued) {
            this.pendingMessageWallWishes.push(wish);
        }
    }

    showMessageWallWishImmediately(wish) {
        if (!wish || wish.id === undefined || wish.id === null) return;
        const wishId = String(wish.id);

        this.pendingMessageWallWishes = this.pendingMessageWallWishes.filter(item => String(item.id) !== wishId);

        const visibleCard = this.wishCards.find(card => String(card.element.dataset.wishId) === wishId);
        if (visibleCard) {
            this.armMessageWallCard(visibleCard, wish, true, 0);
            return;
        }

        if (this.wishCards.length < this.getVisibleWishLimit()) {
            this.addMessageWallWish(wish, true);
            return;
        }

        const reusableCard = [...this.wishCards]
            .filter(card => card.phase !== 'closing')
            .sort((a, b) => {
                const aHolding = a.phase === 'holding' ? 0 : 1;
                const bHolding = b.phase === 'holding' ? 0 : 1;
                if (aHolding !== bHolding) return aHolding - bHolding;
                return (a.phaseStartedAt || 0) - (b.phaseStartedAt || 0);
            })[0] || this.wishCards[0];

        if (reusableCard) {
            this.armMessageWallCard(reusableCard, wish, true, 0);
        } else {
            this.queueMessageWallWish(wish);
        }
    }

    getVisibleWishIdSet(excludeCard = null) {
        return new Set(
            this.wishCards
                .filter(card => card !== excludeCard)
                .map(card => String(card.element.dataset.wishId))
        );
    }

    getNextMessageWallWish(excludeIds = new Set(), currentWishId = null) {
        const excluded = new Set([...excludeIds].map(id => String(id)));

        for (let i = 0; i < this.pendingMessageWallWishes.length; i++) {
            const candidate = this.pendingMessageWallWishes[i];
            if (!excluded.has(String(candidate.id))) {
                this.pendingMessageWallWishes.splice(i, 1);
                return candidate;
            }
        }

        const pool = Array.isArray(this.allServerWishes) ? [...this.allServerWishes] : [];
        return this.selectOrderedWish(pool, {
            excludeIds: excluded,
            currentWishId,
            allowExcludedFallback: true
        });
    }

    applyMessageWallContent(card, wish, slot = null) {
        if (!card) return;
        const textEl = card.querySelector('.wish-text');
        const nameEl = card.querySelector('.child-name');
        if (textEl) {
            textEl.innerHTML = wish && wish.wishText
                ? this.formatMessageWallHtml(wish.wishText)
                : 'Dilek metni bekleniyor.';
        }
        if (nameEl) {
            nameEl.textContent = wish && wish.childName ? wish.childName : 'ISIM BEKLENIYOR';
        }
        this.fitMessageWallTypography(card, slot);
        requestAnimationFrame(() => this.fitMessageWallTypography(card, slot));
    }

    getMessageWallTypographyConfig(slot) {
        const variant = slot && slot.variant === 'large' ? 'large' : 'small';
        if (variant === 'large') {
            return {
                textTop: 12,
                textSidePadding: 14,
                textMinWidth: 178,
                textMaxWidth: 236,
                textMinFont: 21,
                textMaxFont: 30,
                textLineHeight: 1.06,
                nameBottom: 14,
                nameMinWidth: 204,
                nameMaxWidth: 220,
                nameMinFont: 14,
                nameMaxFont: 20,
                nameLineHeight: 1.05,
                nameReserve: 48,
                nameMaxHeight: 30,
                maxLines: 6
            };
        }
        return {
            textTop: 8,
            textSidePadding: 12,
            textMinWidth: 120,
            textMaxWidth: 160,
            textMinFont: 14,
            textMaxFont: 19,
            textLineHeight: 1.14,
            nameBottom: 10,
            nameMinWidth: 132,
            nameMaxWidth: 148,
            nameMinFont: 10,
            nameMaxFont: 14,
            nameLineHeight: 1.05,
            nameReserve: 32,
            nameMaxHeight: 22,
            maxLines: 8
        };
    }

    fitTextToBox(element, {
        minFont,
        maxFont,
        maxHeight,
        maxWidth,
        lineHeight,
        maxLines = 8
    }) {
        if (!element) return;
        element.style.fontSize = `${maxFont}px`;
        element.style.lineHeight = String(lineHeight);
        element.style.maxWidth = `${Math.max(1, maxWidth)}px`;
        element.style.width = `${Math.max(1, maxWidth)}px`;
        element.style.maxHeight = `${Math.max(1, maxHeight)}px`;
        element.style.webkitLineClamp = String(maxLines);

        for (let size = maxFont; size >= minFont; size -= 0.5) {
            element.style.fontSize = `${size}px`;
            const fitsHeight = element.scrollHeight <= maxHeight + 1;
            const fitsWidth = element.scrollWidth <= maxWidth + 1;
            if (fitsHeight && fitsWidth) {
                return size;
            }
        }

        element.style.fontSize = `${minFont}px`;
        return minFont;
    }

    fitMessageWallTypography(card, slot = null) {
        if (!card) return;
        const contentEl = card.querySelector('.message-card-content');
        const textEl = card.querySelector('.wish-text');
        const nameEl = card.querySelector('.child-name');
        if (!contentEl || !textEl || !nameEl) return;

        const resolvedSlot = slot
            || this.getMessageWallSlotByKey(card.dataset.slotKey)
            || { variant: card.classList.contains('messagewall-slot--hero') ? 'large' : 'small' };
        const cfg = this.getMessageWallTypographyConfig(resolvedSlot);
        const contentWidth = contentEl.clientWidth || 0;
        const contentHeight = contentEl.clientHeight || 0;
        if (!contentWidth || !contentHeight) return;

        const textWidth = Math.max(
            cfg.textMinWidth,
            Math.min(cfg.textMaxWidth, contentWidth - (cfg.textSidePadding * 2))
        );
        const textLeft = Math.max(0, Math.round((contentWidth - textWidth) / 2));
        const textMaxHeight = Math.max(36, contentHeight - cfg.nameReserve - cfg.textTop);

        textEl.style.top = `${cfg.textTop}px`;
        textEl.style.left = `${textLeft}px`;
        textEl.style.right = 'auto';
        textEl.style.textAlign = 'left';
        textEl.style.width = `${textWidth}px`;
        textEl.style.maxWidth = `${textWidth}px`;
        textEl.style.maxHeight = `${textMaxHeight}px`;
        this.fitTextToBox(textEl, {
            minFont: cfg.textMinFont,
            maxFont: cfg.textMaxFont,
            maxHeight: textMaxHeight,
            maxWidth: textWidth,
            lineHeight: cfg.textLineHeight,
            maxLines: cfg.maxLines
        });

        const nameWidth = Math.max(
            cfg.nameMinWidth,
            Math.min(cfg.nameMaxWidth, textWidth + 18)
        );
        const nameLeft = Math.max(0, Math.round((contentWidth - nameWidth) / 2));
        nameEl.style.left = `${nameLeft}px`;
        nameEl.style.right = 'auto';
        nameEl.style.bottom = `${cfg.nameBottom}px`;
        nameEl.style.width = `${nameWidth}px`;
        nameEl.style.maxWidth = `${nameWidth}px`;
        nameEl.style.textAlign = 'left';

        this.fitTextToBox(nameEl, {
            minFont: cfg.nameMinFont,
            maxFont: cfg.nameMaxFont,
            maxHeight: cfg.nameMaxHeight || 26,
            maxWidth: nameWidth,
            lineHeight: cfg.nameLineHeight,
            maxLines: 1
        });
    }

    fitFloatingCardTypography(card) {
        if (!card || card.classList.contains('messagewall-mode')) return;

        const textEl = card.querySelector('.wish-text');
        const nameEl = card.querySelector('.child-name');

        if (card.classList.contains('lantern-mode') || card.classList.contains('star-lantern-mode')) {
            const isStarLantern = card.classList.contains('star-lantern-mode');
            const textWidth = isStarLantern ? 164 : 148;
            const textBox = card.querySelector('.lantern-text');
            if (textBox) {
                textBox.style.width = `${textWidth}px`;
                textBox.style.overflow = 'visible';
            }

            if (textEl) {
                this.fitTextToBox(textEl, {
                    minFont: 10,
                    maxFont: isStarLantern ? 20 : 14,
                    maxHeight: isStarLantern ? 170 : 122,
                    maxWidth: textWidth,
                    lineHeight: isStarLantern ? 1.16 : 1.18,
                    maxLines: isStarLantern ? 6 : 7
                });
            }

            if (nameEl) {
                nameEl.style.whiteSpace = 'nowrap';
                nameEl.style.wordBreak = 'keep-all';
                nameEl.style.overflowWrap = 'normal';
                const nameWidth = isStarLantern ? 172 : 160;
                nameEl.style.width = `${nameWidth}px`;
                nameEl.style.maxWidth = `${nameWidth}px`;
                nameEl.style.textAlign = 'center';
                this.fitTextToBox(nameEl, {
                    minFont: 9,
                    maxFont: isStarLantern ? 18 : 13,
                    maxHeight: isStarLantern ? 24 : 18,
                    maxWidth: nameWidth,
                    lineHeight: 1,
                    maxLines: 1
                });
            }
            return;
        }

        if (textEl) {
            this.fitTextToBox(textEl, {
                minFont: 13,
                maxFont: 20,
                maxHeight: 190,
                maxWidth: 240,
                lineHeight: 1.25,
                maxLines: 8
            });
        }

        if (nameEl) {
            nameEl.style.whiteSpace = 'nowrap';
            nameEl.style.wordBreak = 'keep-all';
            nameEl.style.overflowWrap = 'normal';
            this.fitTextToBox(nameEl, {
                minFont: 11,
                maxFont: 18,
                maxHeight: 24,
                maxWidth: 250,
                lineHeight: 1.15,
                maxLines: 1
            });
        }
    }

    easeOutBack(t) {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }

    easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    lerp(start, end, t) {
        return start + (end - start) * t;
    }

    getMessageWallEntranceStyle() {
        const style = this.displaySettings && typeof this.displaySettings.messageWallEntranceStyle === 'string'
            ? this.displaySettings.messageWallEntranceStyle
            : 'standard';
        const normalized = style === 'soft' ? 'glide' : style;
        return ['standard', 'glide', 'pop'].includes(normalized) ? normalized : 'standard';
    }

    getMessageWallEntrancePreset(slot, entranceStyle = this.getMessageWallEntranceStyle()) {
        const dropDistance = slot && slot.variant === 'large' ? 180 : 140;
        const normalized = entranceStyle === 'soft' ? 'glide' : entranceStyle;
        const style = ['standard', 'glide', 'pop'].includes(normalized) ? normalized : 'standard';

        if (style === 'glide') {
            const horizontalOffset = slot.key === 'hero'
                ? -96
                : slot.key.includes('left')
                    ? -118
                    : 118;
            return {
                style,
                startX: slot.x + horizontalOffset,
                startY: slot.y + (slot.variant === 'large' ? 14 : 10),
                startScale: 0.96,
                startBlur: 12,
                startRotation: horizontalOffset < 0 ? -5.5 : 5.5
            };
        }

        if (style === 'pop') {
            return {
                style,
                startX: slot.x,
                startY: slot.y + (slot.variant === 'large' ? 16 : 12),
                startScale: 0.82,
                startBlur: 14,
                startRotation: 0
            };
        }

        return {
            style: 'standard',
            startX: slot.x,
            startY: slot.y - dropDistance,
            startScale: 0.94,
            startBlur: 7,
            startRotation: 0
        };
    }

    getMessageWallEntranceFrame(cardData, slot, progress) {
        const preset = this.getMessageWallEntrancePreset(slot, cardData && cardData.entranceStyle);
        const clamped = Math.max(0, Math.min(1, progress));

        if (preset.style === 'glide') {
            const moveEase = this.easeOutCubic(clamped);
            const settleEase = this.easeOutBack(clamped);
            return {
                x: this.lerp(preset.startX, slot.x, moveEase),
                y: this.lerp(preset.startY, slot.y, moveEase),
                opacity: Math.min(1, 0.16 + clamped * 1.08),
                renderScale: this.lerp(preset.startScale, 1, settleEase),
                blur: (1 - clamped) * preset.startBlur,
                rotation: this.lerp(preset.startRotation || 0, 0, settleEase)
            };
        }

        if (preset.style === 'pop') {
            const moveEase = this.easeOutCubic(clamped);
            const scaleEase = this.easeOutBack(clamped);
            return {
                x: slot.x,
                y: this.lerp(preset.startY, slot.y, moveEase),
                opacity: Math.min(1, 0.18 + clamped * 1.2),
                renderScale: this.lerp(preset.startScale, 1, scaleEase),
                blur: (1 - clamped) * preset.startBlur,
                rotation: 0
            };
        }

        const eased = this.easeOutBack(clamped);
        return {
            x: slot.x,
            y: this.lerp(preset.startY, slot.y, eased),
            opacity: Math.min(1, clamped * 1.25),
            renderScale: this.lerp(preset.startScale, 1, eased),
            blur: (1 - clamped) * preset.startBlur,
            rotation: 0
        };
    }

    armMessageWallCard(cardData, wish, animate = true, delayMs = 0) {
        if (!cardData || !cardData.element || !cardData.slot) return;
        const slot = cardData.slot;
        const currentScale = this.displaySettings.scaleMultiplier || 1.0;
        const now = performance.now();
        const oldWishId = cardData.element.dataset.wishId;
        const entrancePreset = this.getMessageWallEntrancePreset(slot);

        if (oldWishId) {
            this.wishes = this.wishes.filter(item => String(item.id) !== String(oldWishId));
        }
        if (wish) {
            this.wishes.push(wish);
            this.recordWishShown(wish);
        }

        cardData.element.dataset.wishId = wish ? wish.id : '';
        cardData.element.dataset.slotKey = slot.key;
        cardData.element.dataset.slotVariant = slot.variant;
        cardData.element.className = `wish-card messagewall-mode ${slot.className}`.trim();
        cardData.element.style.setProperty('--message-card-width', `${slot.width}px`);
        cardData.element.style.setProperty('--message-card-height', `${slot.height}px`);
        cardData.element.style.setProperty('--message-card-z', `${slot.zIndex}`);
        this.applyMessageWallContent(cardData.element, wish, slot);

        cardData.cardWidth = slot.width;
        cardData.cardHeight = slot.height;
        cardData.rotation = 0;
        cardData.slotX = slot.x;
        cardData.slotY = slot.y;
        cardData.phase = animate ? 'entering' : 'holding';
        cardData.phaseStartedAt = now + (animate ? delayMs : 0);
        cardData.enterDuration = 560 + Math.random() * 120;
        cardData.holdDuration = 7200 + Math.random() * 1800;
        cardData.exitDuration = 380 + Math.random() * 140;
        cardData.entranceStyle = entrancePreset.style;
        cardData.startX = entrancePreset.startX;
        cardData.startY = entrancePreset.startY;
        cardData.endY = slot.y;
        cardData.x = animate ? entrancePreset.startX : slot.x;
        cardData.y = animate ? cardData.startY : slot.y;
        cardData.opacity = animate ? 0 : 1;
        cardData.renderScale = animate ? entrancePreset.startScale : 1;
        cardData.rotation = animate ? (entrancePreset.startRotation || 0) : 0;
        cardData.element.style.opacity = cardData.opacity.toString();
        cardData.element.style.setProperty('--messagewall-blur', animate ? `${entrancePreset.startBlur}px` : '0px');
        cardData.element.style.transform = `translate3d(${cardData.x}px, ${cardData.y}px, 0) scale(${currentScale * cardData.renderScale}) rotate(0deg)`;
    }

    updateMessageWallCard(cardData, now, currentSpeedMulti) {
        if (!cardData || !cardData.slot) return;
        if (now < cardData.phaseStartedAt) {
            cardData.element.style.opacity = '0';
            cardData.element.style.setProperty('--messagewall-blur', '7px');
            return;
        }

        const elapsed = (now - cardData.phaseStartedAt) * currentSpeedMulti;
        const slot = cardData.slot;

        if (cardData.phase === 'entering') {
            const progress = Math.max(0, Math.min(1, elapsed / cardData.enterDuration));
            const frame = this.getMessageWallEntranceFrame(cardData, slot, progress);
            cardData.x = frame.x;
            cardData.y = frame.y;
            cardData.opacity = frame.opacity;
            cardData.renderScale = frame.renderScale;
            cardData.rotation = frame.rotation || 0;
            cardData.element.style.setProperty('--messagewall-blur', `${frame.blur}px`);
            if (progress >= 1) {
                cardData.phase = 'holding';
                cardData.phaseStartedAt = now;
                cardData.x = slot.x;
                cardData.y = slot.y;
                cardData.opacity = 1;
                cardData.renderScale = 1;
                cardData.rotation = 0;
                cardData.element.style.setProperty('--messagewall-blur', '0px');
            }
            return;
        }

        if (cardData.phase === 'holding') {
            cardData.x = slot.x;
            cardData.y = slot.y;
            cardData.opacity = 1;
            cardData.renderScale = 1;
            cardData.element.style.setProperty('--messagewall-blur', '0px');
            if (elapsed >= cardData.holdDuration) {
                cardData.phase = 'closing';
                cardData.phaseStartedAt = now;
            }
            return;
        }

        const progress = Math.max(0, Math.min(1, elapsed / cardData.exitDuration));
        const eased = progress * progress * progress;
        cardData.x = slot.x;
        cardData.y = slot.y + 18 * eased;
        cardData.opacity = 1 - eased;
        cardData.renderScale = 1 - 0.08 * eased;
        cardData.element.style.setProperty('--messagewall-blur', `${eased * 6}px`);

        if (progress >= 1) {
            const currentWishId = cardData.element.dataset.wishId;
            const visibleIds = this.getVisibleWishIdSet(cardData);
            const nextWish = this.getNextMessageWallWish(visibleIds, currentWishId);

            if (!nextWish) {
                cardData.element.remove();
                this.wishCards = this.wishCards.filter(item => item !== cardData);
                this.wishes = this.wishes.filter(item => String(item.id) !== String(currentWishId));
                this.emptyState.style.display = this.wishCards.length ? 'none' : '';
                return;
            }

            this.armMessageWallCard(cardData, nextWish, true, 0);
        }
    }

    addMessageWallWish(wish, animate = true) {
        const slot = this.getNextMessageWallSlot();
        const maxVisible = this.getVisibleWishLimit();

        if (!slot || this.wishCards.length >= maxVisible) {
            this.queueMessageWallWish(wish);
            return;
        }

        const card = document.createElement('div');
        card.className = `wish-card messagewall-mode ${slot.className}`;
        card.dataset.slotKey = slot.key;
        card.style.left = '0px';
        card.style.top = '0px';
        card.innerHTML = `
            <div class="message-card-shell">
                <div class="message-card-fill"></div>
                <div class="message-card-content">
                    <div class="wish-text"></div>
                    <div class="child-name"></div>
                </div>
            </div>
        `;

        this.container.appendChild(card);

        const cardData = {
            element: card,
            x: slot.x,
            y: slot.y,
            rotation: 0,
            zDepth: 1,
            renderScale: 1,
            opacity: 0,
            cardWidth: slot.width,
            cardHeight: slot.height,
            isMessageWall: true,
            slotKey: slot.key,
            slot,
            phase: 'entering',
            phaseStartedAt: performance.now(),
            enterDuration: 600,
            holdDuration: 7600,
            exitDuration: 420
        };

        this.wishCards.push(cardData);
        this.armMessageWallCard(cardData, wish, animate, slot.delay);
    }

    getMessageWallLayout(cardWidth = 240, cardHeight = 230) {
        const cw = this.container.offsetWidth || DESIGN_WIDTH;
        const ch = this.container.offsetHeight || DESIGN_HEIGHT;
        const laneCount = 4;
        const leftInset = 128;
        const rightInset = 520;
        const usableWidth = Math.max(1, cw - leftInset - rightInset - cardWidth);
        const lanes = Array.from({ length: laneCount }, (_, index) => {
            if (laneCount === 1) return leftInset;
            return Math.round(leftInset + ((usableWidth * index) / (laneCount - 1)));
        });
        const rows = [470, 650, 820].filter(row => row + cardHeight < ch - 72);

        return {
            cw,
            ch,
            lanes,
            rows,
            fadeStart: 430,
            exitY: 220 - cardHeight,
            safeAreas: [
                { left: 20, top: 18, right: 360, bottom: 190, penalty: 2600 },
                { left: 300, top: 86, right: 1630, bottom: 404, penalty: 4200 },
                { left: 18, top: 724, right: 250, bottom: ch, penalty: 2200 },
                { left: 1380, top: 420, right: cw, bottom: ch, penalty: 2600 }
            ]
        };
    }

    doRectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
        return ax < (bx + bw) && (ax + aw) > bx && ay < (by + bh) && (ay + ah) > by;
    }

    scoreMessageWallPosition(x, y, cardWidth, cardHeight, excludeCard = null) {
        const layout = this.getMessageWallLayout(cardWidth, cardHeight);
        let score = 0;

        for (const area of layout.safeAreas) {
            if (this.doRectsOverlap(x, y, cardWidth, cardHeight, area.left, area.top, area.right - area.left, area.bottom - area.top)) {
                score -= area.penalty;
            }
        }

        for (const card of this.wishCards) {
            if (!card || card === excludeCard) continue;
            const otherWidth = card.cardWidth || 260;
            const otherHeight = card.cardHeight || 240;
            const otherX = card.swayBaseX || card.x || 0;
            const otherY = card.y || 0;
            const dx = x - otherX;
            const dy = y - otherY;
            const distance = Math.sqrt((dx * 1.55) * (dx * 1.55) + dy * dy);

            score += Math.min(distance, 420);

            if (this.doRectsOverlap(x, y, cardWidth, cardHeight, otherX, otherY, otherWidth, otherHeight)) {
                score -= 3600;
            } else if (Math.abs(dx) < ((cardWidth + otherWidth) * 0.55) && Math.abs(dy) < ((cardHeight + otherHeight) * 0.65)) {
                score -= 1500;
            }
        }

        return score;
    }

    getBestMessageWallInitialPlacement(cardWidth, cardHeight) {
        const layout = this.getMessageWallLayout(cardWidth, cardHeight);
        const candidates = [];

        layout.rows.forEach((row) => {
            layout.lanes.forEach((lane) => {
                candidates.push({
                    x: lane + (Math.random() - 0.5) * 18,
                    y: row + (Math.random() - 0.5) * 26
                });
            });
        });

        let bestCandidate = candidates[0] || { x: 120, y: 420 };
        let bestScore = -Infinity;

        for (const candidate of candidates) {
            const score = this.scoreMessageWallPosition(candidate.x, candidate.y, cardWidth, cardHeight);
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = candidate;
            }
        }

        return bestCandidate;
    }

    getBestMessageWallSpawnX(spawnY, cardWidth, cardHeight, excludeCard = null) {
        const layout = this.getMessageWallLayout(cardWidth, cardHeight);
        const candidates = layout.lanes.map((lane) => lane + (Math.random() - 0.5) * 14);
        let bestX = candidates[0] || 120;
        let bestScore = -Infinity;

        for (const candidateX of candidates) {
            const score = this.scoreMessageWallPosition(candidateX, spawnY, cardWidth, cardHeight, excludeCard);
            if (score > bestScore) {
                bestScore = score;
                bestX = candidateX;
            }
        }

        const minX = 72;
        const maxX = Math.max(minX, layout.cw - cardWidth - 72);
        return Math.max(minX, Math.min(maxX, bestX));
    }


    addWish(wish, animate = true) {
        // Duplicate guard: ayni ID zaten varsa ekleme
        if (this.wishes.some(w => String(w.id) === String(wish.id))) {
            if (this.isMessageWallMode()) {
                this.queueMessageWallWish(wish);
            }
            console.warn('⚠️ Duplicate wish skipped:', wish.id);
            return;
        }

        this.emptyState.style.display = 'none';
        if (this.isMessageWallMode()) {
            this.addMessageWallWish(wish, animate);
            return;
        }

        const renderedText = wish.wishText
            ? (wish.wishText.length > 180 ? wish.wishText.substring(0, 180) + '…' : wish.wishText).replace(/\n/g, '<br>')
            : '';

        // Rich balloon colors with dark variants for gradient
        const balloonPalette = [
            { color: '#FF6B6B', dark: '#D94949', rgb: '255,107,107' },
            { color: '#4ECDC4', dark: '#35A89F', rgb: '78,205,196' },
            { color: '#FFE66D', dark: '#DAC044', rgb: '255,230,109' },
            { color: '#A8E6CF', dark: '#7DC4A7', rgb: '168,230,207' },
            { color: '#FF8E8E', dark: '#D96A6A', rgb: '255,142,142' },
            { color: '#88D8F7', dark: '#5FB8D6', rgb: '136,216,247' },
            { color: '#DDA0DD', dark: '#B87DB8', rgb: '221,160,221' },
            { color: '#FFB347', dark: '#D9922E', rgb: '255,179,71' },
            { color: '#FF85A2', dark: '#D96483', rgb: '255,133,162' },
            { color: '#7EC8E3', dark: '#5AA3BD', rgb: '126,200,227' },
            { color: '#C3AED6', dark: '#9E89B1', rgb: '195,174,214' },
            { color: '#95E1D3', dark: '#6FC1B3', rgb: '149,225,211' }
        ];
        const palette = balloonPalette[Math.floor(Math.random() * balloonPalette.length)];

        const card = document.createElement('div');
        card.dataset.wishId = wish.id;
        const isMessageWall = this.isMessageWallMode();
        const isFloatingLantern = this.isFloatingLanternMode();
        const isStarLantern = this.isStarLanternMode();
        let messageWallCardWidth = 0;
        let messageWallCardHeight = 0;
        let messageWallLayer = 'foreground';

        if (isMessageWall) {
            const accent = Math.random() > 0.72 ? '#ff86a6' : '#ffffff';
            const cardWidth = accent === '#ff86a6' ? 308 : 256;
            const cardHeight = accent === '#ff86a6' ? 308 : 244;
            messageWallCardWidth = cardWidth;
            messageWallCardHeight = cardHeight;
            messageWallLayer = 'foreground';
            card.className = `wish-card messagewall-mode ${animate ? 'card-entering' : ''} is-foreground-layer`.trim();
            card.style.setProperty('--message-card-width', `${cardWidth}px`);
            card.style.setProperty('--message-card-height', `${cardHeight}px`);
            card.style.setProperty('--message-border', accent);
            card.innerHTML = `
                <div class="message-card-shell">
                    ${renderedText ? `<div class="wish-text">${renderedText}</div>` : '<div class="wish-text">Dilek metni bekleniyor.</div>'}
                    <div class="child-name">${wish.childName}</div>
                </div>
            `;
        } else if (isStarLantern) {
            card.className = 'wish-card star-lantern-mode' + (animate ? ' entering' : '');
            card.innerHTML = `
                <div class="star-lantern-body" aria-hidden="true"></div>
                <div class="star-lantern-text lantern-text">
                    ${wish.wishText ? `<div class="wish-text">${(wish.wishText.length > 140 ? wish.wishText.substring(0, 140) + '...' : wish.wishText).replace(/\n/g, '<br>')}</div>` : ''}
                    <div class="child-name">${wish.childName}</div>
                </div>
            `;
        } else if (isFloatingLantern) {
            card.className = 'wish-card lantern-mode' + (animate ? ' entering' : '');
            card.innerHTML = `
                <div class="lantern-body">
                    <div class="lantern-flame"></div>
                </div>
                <div class="lantern-string"></div>
                <div class="lantern-text">
                    ${wish.wishText ? `<div class="wish-text">${(wish.wishText.length > 140 ? wish.wishText.substring(0, 140) + '…' : wish.wishText).replace(/\n/g, '<br>')}</div>` : ''}
                    <div class="child-name">${wish.childName}</div>
                </div>
            `;
        } else {
            card.className = 'wish-card' + (animate ? ' entering' : '');
            card.style.setProperty('--balloon-color', palette.color);
            card.style.setProperty('--balloon-color-dark', palette.dark);
            card.style.setProperty('--balloon-color-rgb', palette.rgb);
            card.style.setProperty('--bob-duration', (3 + Math.random() * 3) + 's');
            card.style.setProperty('--bob-delay', (Math.random() * -5) + 's');
            card.innerHTML = `
                <div class="balloon-body">
                    ${wish.wishText ? `<div class="wish-text">${(wish.wishText.length > 140 ? wish.wishText.substring(0, 140) + '…' : wish.wishText).replace(/\n/g, '<br>')}</div>` : ''}
                    <div class="child-name">${wish.childName}</div>
                </div>
                <div class="balloon-string"></div>
            `;
        }


        // Görsel kalabalığı azaltmak için ekran maksimum limit koruması

        // Görsel kalabalığı azaltmak için ekran maksimum limit koruması
        const maxVisible = this.getVisibleWishLimit();
        if (this.wishCards.length >= maxVisible) {
            // En eski giren balonu ekran dizisinden çıkart (fade-out ile)
            const removableCard = isMessageWall
                ? this.wishCards.reduce((topCard, current) => (current.y < topCard.y ? current : topCard), this.wishCards[0])
                : this.wishCards[0];
            const removeIndex = this.wishCards.indexOf(removableCard);
            if (removeIndex > -1) {
                this.wishCards.splice(removeIndex, 1);
            }
            if (removableCard && removableCard.element) {
                const wishIdToRemove = removableCard.element.dataset.wishId;
                this.wishes = this.wishes.filter(w => w.id !== wishIdToRemove);
                removableCard.element.style.transition = 'opacity 0.5s ease';
                removableCard.element.style.opacity = '0';
                setTimeout(() => {
                    if (removableCard.element.parentNode) removableCard.element.remove();
                }, 500);
            }
        }

        // Remove constraints so they can spawn edge-to-edge
        const cw = this.container.offsetWidth;
        const ch = this.container.offsetHeight;
        const padding = 0;
        const currentScale = this.displaySettings.scaleMultiplier || 1.0;
        const cardWidth = isMessageWall ? (messageWallCardWidth || 280) : (isStarLantern ? 340 : 320);
        const placementCardWidth = isStarLantern ? Math.max(120, cardWidth * currentScale) : cardWidth;
        const maxX = cw - placementCardWidth;

        // Y ekseni: fener modunda ekranın tam altından doğar, rastgele dağılım ile
        const maxSpawnDepth = Math.min(this.wishCards.length * (isMessageWall ? 45 : (isFloatingLantern ? 250 : 150)), isMessageWall ? 360 : ch);
        const spawnOffset = Math.random() * maxSpawnDepth;
        let y;
        if (isMessageWall) {
            y = animate
                ? ch + 120 + spawnOffset + Math.random() * 80
                : 0;
        } else if (animate && isFloatingLantern) {
            y = ch - 200 - Math.random() * 200;
        } else {
            y = isFloatingLantern
                ? -200 + Math.random() * (ch + 400)   // Distribute across full visible screen + margins
                : ch + 200 + spawnOffset + Math.random() * 1000;
        }

        // X ekseninde konum — 2D aday skorlama ile en iyi pozisyon
        const tempSwayAmp = isMessageWall ? (7 + Math.random() * 7) : (30 + Math.random() * 30);  // 30-60px (daraltıldı — overlap önleme)
        const spawnSwayAmp = isStarLantern ? (18 + Math.random() * 20) : tempSwayAmp;
        let x;
        if (isMessageWall) {
            if (animate) {
                x = this.getBestMessageWallSpawnX(y, cardWidth, messageWallCardHeight || 230);
            } else {
                const initialPlacement = this.getBestMessageWallInitialPlacement(cardWidth, messageWallCardHeight || 230);
                x = initialPlacement.x;
                y = initialPlacement.y;
            }
        } else if (isFloatingLantern) {
            x = this.findBestSpawnX(y, spawnSwayAmp, placementCardWidth);
        } else {
            x = padding + Math.random() * Math.max(0, maxX - padding);
        }

        const zDepth = 1.0;

        const rotation = (Math.random() - 0.5) * (isMessageWall ? 2.5 : (isFloatingLantern ? 3 : 8));

        // CSS left/top yerine performansı artırmak için GPU hızlandırmalı transform3d kullanıyoruz.
        card.style.left = '0px';
        card.style.top = '0px';
        card.style.opacity = isMessageWall ? (animate ? '0' : (messageWallLayer === 'background' ? '0.24' : '0.96')) : ((animate && isFloatingLantern) ? '1' : (isFloatingLantern ? '0' : '1'));
        card.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${rotation}deg)`;

        card.addEventListener('click', () => {
            const currentWishId = card.dataset.wishId;
            const currentWish = this.allServerWishes.find(w => w.id === currentWishId) || wish;
            this.showSpotlight(currentWish);
        });

        this.container.appendChild(card);
        this.fitFloatingCardTypography(card);
        requestAnimationFrame(() => this.fitFloatingCardTypography(card));
        this.wishes.push(wish);
        this.recordWishShown(wish);

        // zDepth yukarıda (spawn overlap kontrolünden önce) hesaplandı
        const isNewWishEntry = animate && isFloatingLantern;
        const cardData = {
            element: card,
            x: x,
            y: y,
            vx: isMessageWall ? (Math.random() - 0.5) * 0.05 : (Math.random() - 0.5) * (isFloatingLantern ? 0.5 : 1.5),
            vy: -(isMessageWall ? (0.72 + Math.random() * 0.22) : (isFloatingLantern ? (0.5 + Math.random() * 0.2) : (1.5 + Math.random() * 2))),
            rotation: rotation,
            rotationSpeed: (Math.random() - 0.5) * (isMessageWall ? 0.04 : (isFloatingLantern ? 0.1 : 0.8)),
            radius: isMessageWall ? 160 : (isFloatingLantern ? 250 : 180),
            zDepth: zDepth,
            // Salınım: çoklu sinüs ile doğal rüzgar akışı
            swayPhase: Math.random() * Math.PI * 2,
            swayFreq: isMessageWall ? (0.0018 + Math.random() * 0.0013) : (0.004 + Math.random() * 0.004),
            swayAmp: spawnSwayAmp,
            sway2Phase: Math.random() * Math.PI * 2,
            sway2Freq: isMessageWall ? (0.003 + Math.random() * 0.0018) : (0.009 + Math.random() * 0.007),
            sway2Amp: isMessageWall ? (2 + Math.random() * 4) : (10 + Math.random() * 15),   // 10-25px (daraltıldı)
            swayYPhase: Math.random() * Math.PI * 2,
            swayYFreq: isMessageWall ? (0.0012 + Math.random() * 0.0012) : (0.003 + Math.random() * 0.003),
            swayYAmp: isMessageWall ? (1 + Math.random() * 2) : (5 + Math.random() * 8),
            swayBaseX: x,
            rising: isMessageWall ? animate : !isNewWishEntry,                  // Yeni dilek zaten görünür
            opacity: isMessageWall ? (animate ? 0 : (messageWallLayer === 'background' ? 0.24 : 0.96)) : (isNewWishEntry ? (0.5 + zDepth * 0.5) : 0),
            isNewWish: isMessageWall ? false : isNewWishEntry,                 // Yeni dilek giriş efekti
            cardWidth: cardWidth,
            cardHeight: isMessageWall ? (messageWallCardHeight || 260) : (isStarLantern ? 560 : (isFloatingLantern ? 400 : 300)),
            isMessageWall: isMessageWall,
            targetOpacity: isMessageWall ? (messageWallLayer === 'background' ? 0.24 : 0.96) : 1,
            renderScale: isMessageWall ? (messageWallLayer === 'background' ? 0.9 : 1) : 1,
            laneLayer: messageWallLayer
        };
        this.wishCards.push(cardData);

        if (animate) {
            setTimeout(() => {
                card.classList.remove('entering');
                card.classList.remove('card-entering');
            }, isMessageWall ? 2200 : 1000);

            // Fener modunda yeni dilek giriş efekti — 5 saniyelik altın parıltı
            if (isFloatingLantern) {
                card.classList.add('new-wish-highlight');
                setTimeout(() => {
                    card.classList.remove('new-wish-highlight');
                    cardData.isNewWish = false;
                }, 5000);
            }
        }
    }

    // === ANIMATION WITHOUT PHYSICS (TOP-TO-BOTTOM) ===
    startFloatingAnimation() {
        // Layout Thrashing Fix: Cache the dimensions outside the animation loop
        // Otherwise reading offsetWidth inside the 60FPS loop for 380 items causes 22,800 layout recalcs per second!
        let cw = this.container.offsetWidth || DESIGN_WIDTH;
        let ch = this.container.offsetHeight || DESIGN_HEIGHT;

        window.addEventListener('resize', () => {
            cw = this.container.offsetWidth || DESIGN_WIDTH;
            ch = this.container.offsetHeight || DESIGN_HEIGHT;
        });

        const animate = () => {
            const cards = this.wishCards;
            const now = performance.now();

            const currentScale = this.displaySettings.scaleMultiplier || 1.0;
            const currentSpeedMulti = this.displaySettings.speedMultiplier || 1.0;
            const isMessageWall = this.isMessageWallMode();
            const isFloatingLantern = this.isFloatingLanternMode();
            const isStarLantern = this.isStarLanternMode();
            const paddingSides = isStarLantern ? 12 : 80; // Min kenar boslugu
            const cardWidth = isMessageWall ? 280 : (isStarLantern ? 340 : 320);
            const layoutCardWidth = isStarLantern ? Math.max(120, cardWidth * currentScale) : cardWidth;
            const maxX = cw - layoutCardWidth; // Account for card width so right edge doesn't clip

            cards.forEach(cardData => {
                // Spotlight modunda aktif kartı dondur — animasyonu atla
                if (cardData.element.classList.contains('spotlight-active')) return;
                if (isMessageWall) {
                    this.updateMessageWallCard(cardData, now, currentSpeedMulti);
                    cardData.element.style.opacity = cardData.opacity.toString();
                    cardData.element.style.transform = `translate3d(${cardData.x}px, ${cardData.y}px, 0) scale(${currentScale * (cardData.renderScale || 1)}) rotate(${cardData.rotation || 0}deg)`;
                    return;
                }
                // Admin panelinden gelen hızı doğrudan harekete çarparak uygula
                if (!isMessageWall) {
                    cardData.y += cardData.vy * currentSpeedMulti;
                }

                if (isMessageWall) {
                    cardData.y += cardData.vy * currentSpeedMulti;
                    cardData.swayPhase += cardData.swayFreq * currentSpeedMulti;
                    cardData.sway2Phase += cardData.sway2Freq * currentSpeedMulti;
                    cardData.swayYPhase += cardData.swayYFreq * currentSpeedMulti;
                    cardData.swayBaseX += cardData.vx * currentSpeedMulti;
                    const messageWallLayout = this.getMessageWallLayout(cardData.cardWidth || cardWidth, cardData.cardHeight || 230);
                    const activeCardHeight = cardData.cardHeight || 260;
                    const localCardWidth = cardData.cardWidth || cardWidth;
                    const minMessageX = 72 + cardData.swayAmp;
                    const maxMessageX = Math.max(minMessageX, cw - localCardWidth - 72 - cardData.swayAmp);
                    cardData.swayBaseX = Math.max(minMessageX, Math.min(maxMessageX, cardData.swayBaseX));

                    const swayX = Math.sin(cardData.swayPhase) * cardData.swayAmp
                        + Math.sin(cardData.sway2Phase) * cardData.sway2Amp;
                    cardData.x = cardData.swayBaseX + swayX;
                    cardData.x = Math.max(40, Math.min(cw - localCardWidth - 40, cardData.x));

                    cardData.rotation += cardData.rotationSpeed;
                    if (Math.abs(cardData.rotation) > 4) {
                        cardData.rotationSpeed *= -1;
                    }

                    if (cardData.rising) {
                        const fadeZone = 320;
                        const progress = Math.max(0, Math.min(1, (ch + activeCardHeight * 0.18 - cardData.y) / fadeZone));
                        cardData.opacity = progress * (cardData.targetOpacity || 1);
                        cardData.element.style.opacity = cardData.opacity.toString();
                        if (progress >= 1) cardData.rising = false;
                    } else {
                        const fadeStart = messageWallLayout.fadeStart;
                        const exitY = messageWallLayout.exitY;
                        const fadeOut = Math.max(0, Math.min(1, (cardData.y - exitY) / Math.max(1, fadeStart - exitY)));
                        cardData.opacity = fadeOut * (cardData.targetOpacity || 1);
                        cardData.element.style.opacity = cardData.opacity.toString();
                    }

                    if (!cardData.rising && cardData.y < messageWallLayout.exitY) {
                        const currentMaxVisible = this.getVisibleWishLimit();
                        if (this.wishCards.length > currentMaxVisible) {
                            cardData.element.remove();
                            const idx = this.wishCards.indexOf(cardData);
                            if (idx > -1) this.wishCards.splice(idx, 1);
                            this.wishes = this.wishes.filter(w => w.id !== cardData.element.dataset.wishId);
                            return;
                        }

                        if (this.allServerWishes && this.allServerWishes.length > 0) {
                            const occupiedIds = new Set(cards
                                .filter(other => other !== cardData)
                                .map(other => String(other.element.dataset.wishId)));
                            const nextWish = this.selectOrderedWish(this.allServerWishes, {
                                excludeIds: occupiedIds,
                                currentWishId: cardData.element.dataset.wishId,
                                allowExcludedFallback: true
                            });
                            const accent = Math.random() > 0.72 ? '#ff86a6' : '#ffffff';
                            const nextCardWidth = accent === '#ff86a6' ? 308 : 256;
                            const nextCardHeight = accent === '#ff86a6' ? 308 : 244;
                            const nextLayer = 'foreground';
                            cardData.element.dataset.wishId = nextWish.id;
                            cardData.cardWidth = nextCardWidth;
                            cardData.cardHeight = nextCardHeight;
                            cardData.targetOpacity = nextLayer === 'background' ? 0.24 : 0.96;
                            cardData.renderScale = nextLayer === 'background' ? 0.9 : 1;
                            cardData.laneLayer = nextLayer;
                            cardData.element.classList.toggle('is-background-layer', nextLayer === 'background');
                            cardData.element.classList.toggle('is-foreground-layer', nextLayer !== 'background');
                            cardData.element.style.setProperty('--message-card-width', `${nextCardWidth}px`);
                            cardData.element.style.setProperty('--message-card-height', `${nextCardHeight}px`);
                            cardData.element.style.setProperty('--message-border', accent);
                            const textEl = cardData.element.querySelector('.wish-text');
                            const nameEl = cardData.element.querySelector('.child-name');
                            if (textEl) {
                                textEl.innerHTML = nextWish.wishText
                                    ? (nextWish.wishText.length > 180 ? nextWish.wishText.substring(0, 180) + '…' : nextWish.wishText).replace(/\n/g, '<br>')
                                    : 'Dilek metni bekleniyor.';
                            }
                            if (nameEl && nextWish.childName) nameEl.textContent = nextWish.childName;
                            this.fitMessageWallTypography(cardData.element);
                            this.recordWishShown(nextWish);
                        }

                        cardData.isNewWish = false;
                        cardData.element.classList.remove('new-wish-highlight');
                        cardData.y = ch + 120 + Math.random() * 140;
                        cardData.swayBaseX = this.getBestMessageWallSpawnX(cardData.y, cardData.cardWidth || cardWidth, cardData.cardHeight || activeCardHeight, cardData);
                        cardData.x = cardData.swayBaseX;
                        cardData.vx = (Math.random() - 0.5) * 0.05;
                        cardData.vy = -(0.72 + Math.random() * 0.22);
                        cardData.rotation = (Math.random() - 0.5) * 2.5;
                        cardData.rotationSpeed = (Math.random() - 0.5) * 0.04;
                        cardData.swayPhase = Math.random() * Math.PI * 2;
                        cardData.sway2Phase = Math.random() * Math.PI * 2;
                        cardData.swayYPhase = Math.random() * Math.PI * 2;
                        cardData.rising = true;
                        cardData.opacity = 0;
                        cardData.element.style.opacity = '0';
                    }
                } else if (isFloatingLantern) {
                    // === FENER SALINIMU (SINÜS) — sadece lantern modunda ===
                    cardData.swayPhase += cardData.swayFreq * currentSpeedMulti;
                    cardData.sway2Phase += cardData.sway2Freq * currentSpeedMulti;
                    cardData.swayYPhase += cardData.swayYFreq * currentSpeedMulti;
                    const swayX = Math.sin(cardData.swayPhase) * cardData.swayAmp
                        + Math.sin(cardData.sway2Phase) * cardData.sway2Amp;
                    // === SOFT ANTI-OVERLAP DRIFT ===
                    // Very gentle horizontal push when cards get too close
                    const scaledCardW = (cardData.cardWidth || cardWidth) * currentScale;
                    const scaledCardH = (cardData.cardHeight || (isFloatingLantern ? 400 : 300)) * currentScale;
                    for (const other of cards) {
                        if (other === cardData) continue;
                        const dx = cardData.x - other.x;
                        const dy = cardData.y - other.y;
                        if (Math.abs(dx) < scaledCardW * 0.8 && Math.abs(dy) < scaledCardH * 0.7) {
                            // Cards are overlapping — very gentle push
                            const pushDir = dx >= 0 ? 1 : -1;
                            const overlap = scaledCardW * 0.8 - Math.abs(dx);
                            const pushForce = overlap * 0.005; // Very gentle
                            cardData.swayBaseX += pushDir * pushForce;
                        }
                    }
                    // Clamp swayBaseX drift to prevent edge accumulation
                    const driftFromOriginal = cardData.swayBaseX - cardData.x;
                    // (swayBaseX IS the original spawn X, x is computed from it — no clamping needed on swayBaseX itself, 
                    //  but we clamp it to stay within screen bounds)
                    const layoutWidth = isStarLantern ? Math.max(120, scaledCardW) : (cardData.cardWidth || cardWidth);
                    const swayMaxX = Math.max(paddingSides, cw - layoutWidth - paddingSides);
                    const swayMinX = paddingSides;
                    cardData.swayBaseX = Math.max(swayMinX, Math.min(swayMaxX, cardData.swayBaseX));

                    cardData.x = cardData.swayBaseX + swayX;

                    // Soft boundary clamp — pencere küçültüldüğünde fener ekran dışına çıkmasın
                    cardData.x = Math.max(paddingSides, Math.min(cw - layoutWidth - paddingSides, cardData.x));

                    cardData.y += Math.sin(cardData.swayYPhase) * cardData.swayYAmp * 0.02;

                    // swayBaseX sınırları — fener kenara çıkmasın
                    const swayGuard = isStarLantern ? cardData.swayAmp * 0.35 : cardData.swayAmp;
                    if (cardData.swayBaseX < paddingSides + swayGuard) {
                        cardData.swayBaseX = paddingSides + swayGuard;
                    }
                    if (cardData.swayBaseX > maxX - swayGuard) {
                        cardData.swayBaseX = maxX - swayGuard;
                    }

                    // === FADE-IN: ekran altından yükselirken belirginleş ===
                    if (cardData.rising) {
                        // ch'den ch-400'e kadar olan bölgede opacity 0→maxOpacity
                        const fadeZone = 400;
                        const progress = Math.max(0, Math.min(1, (ch - cardData.y) / fadeZone));
                        const maxOpacity = 1.0;
                        cardData.opacity = progress * maxOpacity;
                        cardData.element.style.opacity = cardData.opacity;
                        if (progress >= 1) cardData.rising = false;
                    }

                    // === FADE-OUT + RESPAWN: header bölgesine yaklaşırken kaybol ===
                    // Header y≈40-200 arasında — fenerler y<300'den itibaren solmaya başlar
                    if (!cardData.rising && cardData.y < 300) {
                        // y=300 → opacity=1, y=-200 → opacity=0 (500px fade zone)
                        const fadeOut = Math.max(0, Math.min(1, (cardData.y + 200) / 500));
                        cardData.element.style.opacity = fadeOut;

                        if (cardData.y < -200) {
                            const currentMaxVisible = isFloatingLantern ? this.getAdaptiveMaxVisible() : ((this.displaySettings && this.displaySettings.maxVisible) || 12);
                            if (this.wishCards.length > currentMaxVisible) {
                                cardData.element.remove();
                                const idx = this.wishCards.indexOf(cardData);
                                if (idx > -1) this.wishCards.splice(idx, 1);
                                this.wishes = this.wishes.filter(w => w.id !== cardData.element.dataset.wishId);
                                return;
                            }
                            // Yeni dilek yükle
                            if (this.allServerWishes && this.allServerWishes.length > 0) {
                                const occupiedIds = new Set(cards
                                    .filter(other => other !== cardData)
                                    .map(other => String(other.element.dataset.wishId)));
                                const nextWish = this.selectOrderedWish(this.allServerWishes, {
                                    excludeIds: occupiedIds,
                                    currentWishId: cardData.element.dataset.wishId,
                                    allowExcludedFallback: true
                                });
                                if (nextWish) this.applyFloatingWishContent(cardData, nextWish, 140);
                            }
                            // Recycling guard: yeni dilek efektini kaldır
                            cardData.isNewWish = false;
                            cardData.element.classList.remove('new-wish-highlight');
                            cardData.zDepth = 1.0;
                            cardData.vy = -(0.5 + Math.random() * 0.2);
                            // Ekranın altından yeni spawn — 2D aday skorlama ile en iyi pozisyon
                            cardData.y = ch + 100 + Math.random() * 400;
                            const recycleCardWidth = isStarLantern ? Math.max(120, (cardData.cardWidth || cardWidth) * currentScale) : (cardData.cardWidth || cardWidth);
                            cardData.swayBaseX = this.findBestSpawnX(cardData.y, cardData.swayAmp, recycleCardWidth);
                            cardData.x = cardData.swayBaseX;
                            cardData.swayPhase = Math.random() * Math.PI * 2;
                            cardData.sway2Phase = Math.random() * Math.PI * 2;
                            cardData.swayYPhase = Math.random() * Math.PI * 2;
                            cardData.rising = true;
                            cardData.opacity = 0;
                            cardData.element.style.opacity = '0';
                        }
                    }

                } else {
                    // Balon modu — eski davranış
                    cardData.x += cardData.vx * currentSpeedMulti;

                    // Rotasyon güncelle + sınır kontrolü
                    cardData.rotation += cardData.rotationSpeed;
                    if (Math.abs(cardData.rotation) > 15) {
                        cardData.rotationSpeed *= -1;
                    }

                    // Yan duvarlardan hafifçe sekmesi
                    if (cardData.x < paddingSides) {
                        cardData.x = paddingSides;
                        cardData.vx *= -0.3;
                    }
                    if (cardData.x > maxX) {
                        cardData.x = maxX;
                        cardData.vx *= -0.3;
                    }

                    // Balon ekranın tavanından tamamen çıktığında tekrar aşağı fırlat
                    if (cardData.y < -600) {
                        cardData.y = ch + 200 + Math.random() * 2000;
                        cardData.x = Math.random() * maxX;

                        if (this.allServerWishes && this.allServerWishes.length > 0) {
                            const occupiedIds = new Set(cards
                                .filter(other => other !== cardData)
                                .map(other => String(other.element.dataset.wishId)));
                            const nextWish = this.selectOrderedWish(this.allServerWishes, {
                                excludeIds: occupiedIds,
                                currentWishId: cardData.element.dataset.wishId,
                                allowExcludedFallback: true
                            });
                            if (nextWish) this.applyFloatingWishContent(cardData, nextWish, 140);
                        }
                    }
                }

                // SADECE GÖRÜNTÜ MATRİSİNİ VE EKSENİNİ (GPU) GÜNCELLE
                // Fener modunda salınım x'i halleder, rotation sadece hafif eğim
                const rot = isMessageWall
                    ? cardData.rotation
                    : isFloatingLantern
                        ? (Math.sin(cardData.swayPhase) + Math.sin(cardData.sway2Phase) * 0.5) * 1.3  // Doğal salınım eğimi
                        : cardData.rotation;
                const depthScale = isMessageWall ? currentScale * (cardData.renderScale || 1) : currentScale;
                cardData.element.style.transform = `translate3d(${cardData.x}px, ${cardData.y}px, 0) scale(${depthScale}) rotate(${rot}deg)`;
            });

            // Removed zAwareSoftDrift

            requestAnimationFrame(animate);
        };

        animate();
    }

    clampPosition(cardData) {
        // Balonların yukarıdan (ekstra negatif Y değerlerinden) doğmasını sağlamak 
        // ve serbestçe aşağı akabilmesini bozmamak için bu kısıtlamalar kaldırılmıştır.
        // Yeni Kar/Yağmur akışında X ve Y ekseni tamamen serbest bırakılmalıdır.
    }


    findBestSpawnX(spawnY, swayAmp, cardWidth = 320) {
        const cw = this.container.offsetWidth;
        const isStarLantern = this.isStarLanternMode();
        // minX/maxX account for sway amplitude so cards don't swing off-screen
        const edgePadding = isStarLantern ? 12 : 68;
        const swayGuard = isStarLantern ? swayAmp * 0.35 : swayAmp;
        const minX = edgePadding + swayGuard;  // paddingSides + swayAmp — kenara yapışmasın
        const maxX = Math.max(minX, cw - cardWidth - edgePadding - swayGuard);

        // Collect positions of on-screen cards
        const ch = this.container.offsetHeight;
        const onScreen = this.wishCards.filter(c => c.y > -600 && c.y < ch + 500);

        if (onScreen.length === 0) {
            // No cards — random position
            return minX + Math.random() * Math.max(0, maxX - minX);
        }

        // Generate evenly-spaced candidate X positions
        const numCandidates = isStarLantern ? 18 : 12;
        const candidates = [];
        for (let i = 0; i < numCandidates; i++) {
            candidates.push(minX + (i / (numCandidates - 1)) * Math.max(0, maxX - minX));
        }

        // Score each candidate: find minimum 2D distance to any existing card
        let bestX = candidates[0];
        let bestMinDist = -1;

        for (const cx of candidates) {
            let minDist = Infinity;
            for (const card of onScreen) {
                const dx = cx - (card.swayBaseX || card.x);
                const dy = spawnY - card.y;
                // Weight X more heavily (1.5x) since horizontal overlap is more visible
                const dist = Math.sqrt((dx * 1.5) * (dx * 1.5) + dy * dy);
                if (dist < minDist) minDist = dist;
            }
            if (minDist > bestMinDist) {
                bestMinDist = minDist;
                bestX = cx;
            }
        }

        // Add small random jitter for organic feel
        const jitterFactor = isStarLantern ? 0.16 : 0.1;
        const jitter = (Math.random() - 0.5) * (maxX - minX) * jitterFactor;
        bestX = Math.max(minX, Math.min(maxX, bestX + jitter));

        return bestX;
    }


    updateCounter() {
        if (!this.counterNumber) return;
        const count = this.totalWishesCount !== undefined ? this.totalWishesCount : this.wishes.length;
        this.counterNumber.textContent = count;
    }

    // === SPOTLIGHT ===
    showSpotlight(wish) {
        if (this.isMessageWallMode()) return;
        const prev = this.container.querySelector('.spotlight-active');
        if (prev) prev.classList.remove('spotlight-active');

        const card = this.container.querySelector(`[data-wish-id="${wish.id}"]`);
        if (card) {
            if (this.isMessageWallMode()) {
                const cardData = this.wishCards.find(c => c.element === card);
                if (cardData) {
                    card.style.setProperty('--spotlight-x', `${cardData.x}px`);
                    card.style.setProperty('--spotlight-y', `${cardData.y}px`);
                    card.style.setProperty('--spotlight-rot', `${cardData.rotation || 0}deg`);
                }
            }
            card.classList.add('spotlight-active');
        }

        this.spotlightName.textContent = wish.childName;
        this.container.classList.add('spotlight-mode');
        this.spotlightOverlay.classList.add('active');
        this.spotlightLabel.classList.add('active');
    }

    hideSpotlight() {
        this.container.classList.remove('spotlight-mode');
        this.spotlightOverlay.classList.remove('active');
        this.spotlightLabel.classList.remove('active');
        const active = this.container.querySelector('.spotlight-active');
        if (active) active.classList.remove('spotlight-active');
    }

    // === WISH MANAGEMENT ===
    removeWish(id) {
        if (this.isMessageWallMode()) {
            this.pendingMessageWallWishes = this.pendingMessageWallWishes.filter(item => String(item.id) !== String(id));
            const cardData = this.wishCards.find(c => String(c.element.dataset.wishId) === String(id));
            if (cardData) {
                cardData.phase = 'closing';
                cardData.phaseStartedAt = performance.now() - (cardData.exitDuration || 400) * 0.35;
            }
            this.wishes = this.wishes.filter(w => String(w.id) !== String(id));
            if (!cardData && this.wishes.length === 0) {
                this.emptyState.style.display = '';
            }
            return;
        }

        const card = this.container.querySelector(`[data-wish-id="${id}"]`);
        if (card) {
            card.style.transition = 'all 0.5s ease';
            card.style.opacity = '0';
            card.style.transform = 'scale(0)';
            setTimeout(() => card.remove(), 500);
        }

        this.wishes = this.wishes.filter(w => w.id !== id);
        this.wishCards = this.wishCards.filter(c => c.element.dataset.wishId !== id);

        if (this.wishes.length === 0) {
            this.emptyState.style.display = '';
        }
    }

    clearAll() {
        this.pendingMessageWallWishes = [];
        const cards = this.container.querySelectorAll('.wish-card');
        cards.forEach((card, i) => {
            card.style.transition = 'all 0.5s ease';
            card.style.transitionDelay = (i * 0.05) + 's';
            card.style.opacity = '0';
            card.style.transform = 'scale(0)';
        });

        setTimeout(() => {
            cards.forEach(c => {
                c.remove();
            });
        }, 800);

        this.wishes = [];
        this.wishCards = [];
        this.emptyState.style.display = '';
        this.updateCounter();
    }

    showNewWishToast(name) {
        const toast = document.getElementById('new-wish-toast');
        if (!toast) return;
        toast.textContent = '\u{1F389} ' + name + ' mesajını paylaştı!';
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // === THEME ===
    // Istegi baslatmakla sonucu uygulamayi ayirir; boylece uclu istek paralel
    // baslatilip eski sirayla uygulanabiliyor. Hata yutma davranisi korunuyor:
    // istek basarisiz olursa null doner ve ilgili adim atlanir.
    async fetchJson(path) {
        try {
            const res = await fetch(`${this.basePath}${path}`);
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    applyThemePayload(data) {
        if (!data) return;
        this.applyTheme(data.theme);
    }

    async loadTheme() {
        this.applyThemePayload(await this.fetchJson('/api/theme'));
    }

    applyTheme(theme) {
        this.currentTheme = theme === 'aselsan' ? 'etnospor' : (theme || 'default');
        document.documentElement.setAttribute('data-background-theme', this.currentTheme);
        this.applyCanvasSize();

        const stageTitle = document.querySelector('.message-stage__headline-text');
        if (stageTitle && this.isMessageWallMode()) {
            stageTitle.textContent = 'PEKİ SENİN DİLEĞİN NE?';
        }
    }

    async loadDisplayMode() {
        const data = await this.fetchJson('/api/display-mode');
        if (!data) return;
        this.displayMode = data.displayMode || 'balloon';
    }

    applyDisplaySettingsPayload(data) {
        if (!data) return;
        this.displaySettings = { ...this.displaySettings, ...data };
        this.applyDisplaySettings();
    }

    async loadDisplaySettings() {
        this.applyDisplaySettingsPayload(await this.fetchJson('/api/display-settings'));
    }
}

// Başlat
document.addEventListener('DOMContentLoaded', () => {
    new WishDisplay();
});
