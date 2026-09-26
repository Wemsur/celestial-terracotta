// 陶瓦联机 (Terracotta) plugin for Celestial Launcher.
//
// Surfaces (each can be turned off in the plugin's settings):
//   - an icon in the left nav rail (slot:navbar.bottom) that opens…
//   - a full page (route /plugin-terracotta)
//   - a card in the right sidebar, below the account card
//     (slot:sidebar.after-account)
//
// It runs the Terracotta sidecar (downloaded on first use) and, on the guest
// side, uses the launcher's LAN-announce capability so the joined world shows
// up in Minecraft's multiplayer list. The player name is confirmed in a modal
// styled to match the launcher's add-offline-account dialog (its own Button and
// Input, NewModal's chrome classes) before each session, and remembered.

const SIDE_KEY = 'terracotta'
const ROUTE_PATH = '/plugin-terracotta'
const NAME_STORAGE_KEY = 'player_name'
const MULTICAST_MOTD = 'Terracotta | Celestial Multiplayer'
const ARCH_MAP = { x86_64: 'x86_64', aarch64: 'arm64', arm64: 'arm64' }

const STATE_LABELS = {
	idle: '空闲',
	starting: '启动中…',
	waiting: '等待中…',
	'host-scanning': '正在扫描本地世界…',
	'host-starting': '开房启动中…',
	'host-ok': '开房成功',
	'guest-connecting': '连接中…',
	'guest-starting': '加入启动中…',
	'guest-ok': '已加入',
	exception: '出错',
	fatal: '致命错误',
}

export async function activate(api) {
	const { h, ref, onUnmounted } = api.vue
	const { Button, Input } = api.ui

	api.styles.add(`
		.tc-card {
			display: flex; flex-direction: column; gap: 10px;
			margin: 1rem;
			padding: 14px; border-radius: 12px;
			border: 1px solid var(--color-button-bg);
		}
		.tc-page { max-width: 720px; margin: 0 auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
		.tc-page-title { color: var(--color-contrast); font-size: 1.4rem; font-weight: 700; margin: 0; }
		.tc-panel {
			display: flex; flex-direction: column; gap: 12px;
			padding: 18px; border-radius: 12px;
			background: var(--color-raised-bg); border: 1px solid var(--color-button-bg);
		}
		.tc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
		.tc-title { color: var(--color-contrast); font-weight: 600; font-size: 0.95rem; }
		.tc-badge { color: var(--color-secondary); font-size: 0.78rem; }
		.tc-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
		.tc-room { color: var(--color-contrast); font-family: monospace; font-size: 1.05rem; letter-spacing: 0.5px; }
		.tc-players { color: var(--color-secondary); font-size: 0.8rem; }
		.tc-error { color: var(--color-red); font-size: 0.8rem; }
		.tc-hint { color: var(--color-secondary); font-size: 0.78rem; }
		.tc-status-line { color: var(--color-secondary); font-size: 0.82rem; }
		.tc-navbtn-active {
			color: var(--color-button-text-selected);
			background: var(--color-button-bg-selected);
		}
		.tc-modal-overlay {
			position: fixed; inset: 0; z-index: 9999;
			display: flex; align-items: center; justify-content: center;
			background: rgba(0,0,0,0.5); backdrop-filter: blur(2px);
		}
	`)

	const state = ref('idle')
	const roomCode = ref('')
	const players = ref([])
	const statusMsg = ref('')
	const errorMsg = ref('')
	const busy = ref(false)
	const active = ref(false)
	const joinCode = ref('')
	const installState = ref({ installed: false, version: null, latest: null, checking: false })

	let handle = null
	let lanHandle = null
	let pollTimer = null
	let announcedPort = null

	// Which surfaces to show. Read once at activate; flipping a toggle in the
	// plugin settings reloads the plugin so it re-registers accordingly.
	const showPage = ((await api.settings.get('show_page')) ?? 'true') !== 'false'
	const showCard = ((await api.settings.get('show_card')) ?? 'true') !== 'false'

	async function readNodes() {
		const raw = (await api.settings.get('public_nodes')) || 'https://etnode.zkitefly.eu.org/node1,https://etnode.zkitefly.eu.org/node2'
		return raw
			.split(/[\n,]/)
			.map((entry) => entry.trim())
			.filter(Boolean)
	}

	// The name the modal pre-fills with: the stored custom name if the user has
	// set one, otherwise the launcher's current account username.
	async function defaultName() {
		const stored = await api.storage.get(NAME_STORAGE_KEY)
		if (stored && stored.trim()) return stored.trim()
		try {
			const username = await api.hostApi.call('auth.default_username')
			if (typeof username === 'string' && username.trim()) return username.trim()
		} catch (error) {
			api.log('could not read default username:', error)
		}
		return 'Player'
	}

	function platformKey() {
		const os = api.platform.os
		const arch = ARCH_MAP[api.platform.arch] || api.platform.arch
		return `${os}-${arch}`
	}

	function mirrorsFor(version) {
		const artifact = `terracotta-${version}-${platformKey()}-pkg.tar.gz`
		return [
			`https://gitee.com/burningtnt/Terracotta/releases/download/v${version}/${artifact}`,
			`https://github.com/burningtnt/Terracotta/releases/download/v${version}/${artifact}`,
		]
	}

	async function latestVersion() {
		try {
			const res = await api.net.fetch(
				'https://gitee.com/api/v5/repos/burningtnt/Terracotta/releases/latest',
			)
			if (res.ok) {
				const tag = JSON.parse(res.body).tag_name
				if (tag) return String(tag).replace(/^v/, '')
			}
		} catch (error) {
			api.log('gitee version lookup failed:', error)
		}
		const res = await api.net.fetch(
			'https://api.github.com/repos/burningtnt/Terracotta/releases/latest',
		)
		if (!res.ok) throw new Error('无法获取陶瓦版本')
		const tag = JSON.parse(res.body).tag_name
		if (!tag) throw new Error('无法获取陶瓦版本')
		return String(tag).replace(/^v/, '')
	}

	async function ensureBinary(version) {
		let lastError
		for (const url of mirrorsFor(version)) {
			try {
				await api.sidecar.ensure(SIDE_KEY, url, {
					sha512Url: `${url}.sha512`,
					archive: 'tar.gz',
					version,
				})
				return
			} catch (error) {
				lastError = error
				api.log('sidecar ensure failed for', url, error)
			}
		}
		throw lastError || new Error('陶瓦下载失败')
	}

	async function refreshStatus() {
		try {
			const status = await api.sidecar.status(SIDE_KEY)
			installState.value = {
				...installState.value,
				installed: status.installed,
				version: status.version,
			}
		} catch (error) {
			api.log('status check failed:', error)
		}
	}

	function control(path) {
		return api.sidecar.request(handle, { path })
	}

	function buildPath(base, pairs) {
		const query = new URLSearchParams()
		for (const [key, value] of pairs) query.append(key, value)
		return `${base}?${query.toString()}`
	}

	async function ensureAndStart() {
		if (api.platform.os === 'macos') {
			throw new Error('陶瓦联机暂不支持 macOS')
		}
		const version = await latestVersion()
		await ensureBinary(version)
		await refreshStatus()
		const started = await api.sidecar.start(SIDE_KEY, ['--hmcl', '{{PORT_FILE}}'], true)
		if (!started.port) throw new Error('未能获取陶瓦端口')
		handle = started.handle
		active.value = true
		startPolling()
	}

	function startPolling() {
		if (pollTimer) return
		pollTimer = setInterval(async () => {
			if (handle == null) return
			try {
				const res = await control('/state')
				if (!res.ok) return
				const data = JSON.parse(res.body)
				state.value = data.state || 'idle'
				if (data.room) roomCode.value = data.room
				players.value = Array.isArray(data.profiles)
					? data.profiles.map((profile) => profile.name).filter(Boolean)
					: []
				if (data.state === 'guest-ok' && data.url) {
					const port = Number.parseInt(String(data.url).split(':').pop(), 10)
					if (port && port !== announcedPort) {
						if (lanHandle != null) await api.lan.stop(lanHandle).catch(() => {})
						const announced = await api.lan.announce(MULTICAST_MOTD, port)
						lanHandle = announced.handle
						announcedPort = port
					}
				}
			} catch (error) {
				api.log('poll error:', error)
			}
		}, 1000)
	}

	async function doHost(name) {
		busy.value = true
		errorMsg.value = ''
		statusMsg.value = '正在准备…'
		try {
			const nodes = await readNodes()
			await ensureAndStart()
			const pairs = [
				['room', ''],
				['player', name],
			]
			for (const node of nodes) pairs.push(['public_nodes', node])
			await control(buildPath('/state/scanning', pairs))
			statusMsg.value = '正在开房，等待房间号…'
		} catch (error) {
			errorMsg.value = String(error?.message || error)
			await stop()
		} finally {
			busy.value = false
		}
	}

	async function doJoin(name, code) {
		busy.value = true
		errorMsg.value = ''
		statusMsg.value = '正在准备…'
		try {
			const nodes = await readNodes()
			await ensureAndStart()
			const pairs = [
				['room', code],
				['player', name],
			]
			for (const node of nodes) pairs.push(['public_nodes', node])
			await control(buildPath('/state/guesting', pairs))
			statusMsg.value = '正在加入…'
		} catch (error) {
			errorMsg.value = String(error?.message || error)
			await stop()
		} finally {
			busy.value = false
		}
	}

	async function stop() {
		if (pollTimer) {
			clearInterval(pollTimer)
			pollTimer = null
		}
		if (handle != null) {
			try {
				await control('/panic?peaceful=true')
			} catch (error) {
				api.log('panic failed:', error)
			}
			try {
				await api.sidecar.stop(handle)
			} catch (error) {
				api.log('stop failed:', error)
			}
			handle = null
		}
		if (lanHandle != null) {
			await api.lan.stop(lanHandle).catch(() => {})
			lanHandle = null
		}
		announcedPort = null
		active.value = false
		state.value = 'idle'
		roomCode.value = ''
		players.value = []
		statusMsg.value = ''
	}

	// Used by the plugin settings page: download or update the binary.
	async function installOrUpdate() {
		installState.value = { ...installState.value, checking: true }
		errorMsg.value = ''
		try {
			const version = await latestVersion()
			await ensureBinary(version)
			await refreshStatus()
			installState.value = { ...installState.value, latest: version }
		} catch (error) {
			errorMsg.value = String(error?.message || error)
		} finally {
			installState.value = { ...installState.value, checking: false }
		}
	}

	async function checkUpdate() {
		installState.value = { ...installState.value, checking: true }
		try {
			const version = await latestVersion()
			installState.value = { ...installState.value, latest: version }
		} catch (error) {
			api.log('check update failed:', error)
		} finally {
			installState.value = { ...installState.value, checking: false }
		}
	}

	function badgeText() {
		if (errorMsg.value) return '出错'
		if (statusMsg.value && !active.value) return statusMsg.value
		return STATE_LABELS[state.value] || state.value
	}

	function copyRoom() {
		if (roomCode.value && navigator.clipboard) {
			void navigator.clipboard.writeText(roomCode.value)
		}
	}

	// The player-name modal. Built to match the launcher's add-offline-account
	// dialog: same Tailwind classes as NewModal's chrome (bg-bg-raised, rounded-2xl,
	// surface-5 border, p-6 header/content, bordered actions row) with the
	// launcher's own Button/Input as controls. Teleported to <body> so it is a
	// true full-window overlay. One instance per host component; whichever the
	// user clicked from shows its own.
	function createNameModal() {
		const visible = ref(false)
		const nameInput = ref('')
		let pending = null

		async function open(action) {
			if (busy.value || active.value) return
			if (action.type === 'join' && !joinCode.value.trim()) {
				errorMsg.value = '请输入房间号'
				return
			}
			errorMsg.value = ''
			pending = action
			nameInput.value = await defaultName()
			visible.value = true
		}

		function hide() {
			visible.value = false
			pending = null
		}

		async function confirm() {
			const name = nameInput.value.trim()
			if (!name) return
			await api.storage.set(NAME_STORAGE_KEY, name)
			const action = pending
			hide()
			if (action?.type === 'host') await doHost(name)
			else if (action?.type === 'join') await doJoin(name, joinCode.value.trim())
		}

		const vnode = () => {
			if (!visible.value) return null
			return h(api.vue.Teleport, { to: 'body' }, [
				h('div', { class: 'tc-modal-overlay', onClick: hide }, [
					h(
						'div',
						{
							class: 'bg-bg-raised rounded-2xl border border-solid border-surface-5 flex flex-col',
							style: 'width: 500px; max-width: calc(100vw - 32px)',
							onClick: (event) => event.stopPropagation(),
						},
						[
							h(
								'div',
								{
									class: 'grid grid-cols-[1fr_auto] items-center gap-4 p-6 border-solid border-0 border-b-[1px] border-surface-5',
								},
								[
									h(
										'span',
										{ class: 'text-2xl font-semibold text-contrast' },
										'设置玩家名',
									),
								],
							),
							h('div', { class: 'p-6' }, [
								h(
									'form',
									{
										class: 'space-y-6',
										onSubmit: (event) => {
											event.preventDefault()
											void confirm()
										},
									},
									[
										h('label', { class: 'flex flex-col gap-2' }, [
											h(
												'span',
												{ class: 'font-semibold text-contrast' },
												'玩家名',
											),
											h(Input, {
												modelValue: nameInput.value,
												'onUpdate:modelValue': (value) => {
													nameInput.value = value
												},
												wrapperClass: 'w-full',
												placeholder: '请输入玩家名…',
											}),
										]),
									],
								),
							]),
							h(
								'div',
								{
									class: 'p-4 border-0 border-t border-solid border-surface-5',
								},
								[
									h('div', { class: 'flex gap-2 justify-end' }, [
										h(Button, { type: 'outlined', onClick: hide }, () => '取消'),
										h(
											Button,
											{
												type: 'colored',
												color: 'brand',
												onClick: () => void confirm(),
											},
											() => '确定',
										),
									]),
								],
							),
						],
					),
				]),
			])
		}

		return { open, vnode }
	}

	// The host/join controls, shared by the sidebar card and the page. Uses the
	// launcher's Button/Input so the controls match the rest of the app.
	function renderControls(modal) {
		const children = []
		if (!active.value) {
			children.push(
				h(Button, {
					type: 'colored',
					color: 'brand',
					class: 'w-full',
					disabled: busy.value,
					onClick: () => void modal.open({ type: 'host' }),
				}, () => '开房'),
				h('div', { class: 'tc-row' }, [
					h(Input, {
						modelValue: joinCode.value,
						'onUpdate:modelValue': (value) => {
							joinCode.value = value
						},
						placeholder: '输入房间号加入',
						wrapperClass: 'flex-1',
					}),
					h(
						Button,
						{
							type: 'outlined',
							disabled: busy.value,
							onClick: () => void modal.open({ type: 'join' }),
						},
						() => '加入',
					),
				]),
			)
		} else {
			if (roomCode.value) {
				children.push(
					h('div', { class: 'tc-row' }, [
						h('span', { class: 'tc-room' }, roomCode.value),
						h(Button, { type: 'outlined', size: 'sm', onClick: copyRoom }, () => '复制房间号'),
					]),
				)
			}
			if (players.value.length) {
				children.push(h('div', { class: 'tc-players' }, `成员：${players.value.join('、')}`))
			}
			children.push(
				h('div', { class: 'tc-row' }, [
					h(
						Button,
						{ type: 'outlined', color: 'danger', onClick: () => void stop() },
						() => '停止',
					),
				]),
			)
		}
		if (errorMsg.value) children.push(h('div', { class: 'tc-error' }, errorMsg.value))
		return children
	}

	// Full page opened from the nav rail.
	api.routes.add({
		path: ROUTE_PATH,
		name: 'terracotta',
		component: {
			name: 'TerracottaPage',
			setup() {
				const modal = createNameModal()
				return () =>
					h('div', { class: 'tc-page' }, [
						h('h1', { class: 'tc-page-title' }, '陶瓦联机'),
						h('div', { class: 'tc-panel' }, [
							h('div', { class: 'tc-head' }, [
								h('span', { class: 'tc-title' }, '状态'),
								h('span', { class: 'tc-badge' }, badgeText()),
							]),
							...renderControls(modal),
							h(
								'div',
								{ class: 'tc-hint' },
								'开一个局域网世界后把房间号发给朋友，或输入房间号加入。首次使用会自动下载陶瓦程序（暂不支持 macOS）。',
							),
						]),
						modal.vnode(),
					])
			},
		},
	})

	// Nav-rail icon that opens the page. Styled with the same classes as the
	// launcher's own NavButton so it sits in the rail identically, including the
	// active highlight (the reactive currentPath drives re-render on navigation).
	if (showPage) api.slots.add('navbar.bottom', {
		id: 'terracotta-nav',
		component: {
			name: 'TerracottaNavButton',
			setup() {
				return () => {
					const isActive = api.router.currentPath.value.startsWith(ROUTE_PATH)
					const classes = [
						'button-animation',
						'border-none',
						'cursor-pointer',
						'w-12',
						'h-12',
						'rounded-full',
						'flex',
						'items-center',
						'justify-center',
						'text-2xl',
						'transition-all',
						'bg-transparent',
						'hover:bg-button-bg',
						'hover:text-contrast',
						isActive ? 'tc-navbtn-active' : 'text-primary',
					].join(' ')
					return h(
						'button',
						{
							class: classes,
							title: '陶瓦联机',
							onClick: () => api.router.push(ROUTE_PATH),
						},
						[
							h(
								'svg',
								{
									width: 26,
									height: 26,
									viewBox: '0 0 24 24',
									fill: 'none',
									stroke: 'currentColor',
									'stroke-width': 2,
									'stroke-linecap': 'round',
									'stroke-linejoin': 'round',
									style: isActive ? 'filter: drop-shadow(0 0 0.5rem black)' : '',
								},
								[
									h('circle', { cx: 12, cy: 12, r: 10 }),
									h('path', { d: 'M2 12h20' }),
									h('path', { d: 'M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20' }),
								],
							),
						],
					)
				}
			},
		},
	})

	// Compact card in the right sidebar, below the "playing as" account card.
	if (showCard) api.slots.add('sidebar.after-account', {
		id: 'terracotta-card',
		component: {
			name: 'TerracottaCard',
			setup() {
				const { onMounted, onUnmounted } = api.vue
				const modal = createNameModal()
				onMounted(() => {
					if (active.value && !pollTimer) startPolling()
				})
				onUnmounted(() => {
					if (pollTimer) {
						clearInterval(pollTimer)
						pollTimer = null
					}
				})
				return () =>
					h('div', { class: 'tc-card bg-bg-raised' }, [
						h('div', { class: 'tc-head' }, [
							h('span', { class: 'tc-title' }, '陶瓦联机'),
							h('span', { class: 'tc-badge' }, badgeText()),
						]),
						...renderControls(modal),
						modal.vnode(),
					])
			},
		},
	})

	// Install status + download/update, shown at the bottom of the plugin's
	// own settings modal.
	api.settings.render({
		id: 'terracotta-settings',
		component: {
			name: 'TerracottaSettings',
			setup() {
				const { onMounted } = api.vue
				onMounted(() => {
					void refreshStatus()
				})
				return () => {
					const info = installState.value
					const children = [h('div', { class: 'font-semibold text-contrast text-sm' }, '陶瓦程序')]
					children.push(
						h(
							'div',
							{ class: 'tc-status-line' },
							info.installed
								? `陶瓦已安装${info.version ? `（版本 ${info.version}）` : ''}`
								: '陶瓦尚未安装',
						),
					)
					if (info.latest) {
						const newer = info.installed && info.version && info.latest !== info.version
						children.push(
							h(
								'div',
								{ class: 'tc-status-line' },
								newer ? `发现新版本：${info.latest}` : `最新版本：${info.latest}`,
							),
						)
					}
					children.push(
						h('div', { class: 'tc-row' }, [
							h(
								Button,
								{
									type: 'colored',
									color: 'brand',
									size: 'sm',
									disabled: info.checking,
									onClick: () => void installOrUpdate(),
								},
								() => (info.checking ? '处理中…' : info.installed ? '重新下载 / 更新' : '下载陶瓦'),
							),
							h(
								Button,
								{
									type: 'outlined',
									size: 'sm',
									disabled: info.checking,
									onClick: () => void checkUpdate(),
								},
								() => '检查更新',
							),
						]),
					)
					if (errorMsg.value) {
						children.push(h('div', { class: 'tc-error' }, errorMsg.value))
					}
					return h('div', { style: 'display:flex;flex-direction:column;gap:8px;' }, children)
				}
			},
		},
	})

	void refreshStatus()
	api.log('activated')
}
