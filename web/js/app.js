/* LinkedIn Analyzer - Main Application */

(function() {
    'use strict';

    const PREVIEW_ROW_LIMIT = 5;
    const PREVIEW_CELL_LIMIT = 50;
    const SCREEN_ANIMATION_MS = 360;

    const FILTER_DEFAULTS = Object.freeze({
        timeRange: '12m',
        topic: 'all',
        monthFocus: null,
        day: null,
        hour: null,
        shareType: 'all'
    });

    const state = {
        currentScreen: 'upload',
        files: {
            shares: null,
            comments: null
        },
        analytics: null,
        analyticsReady: false,
        analyticsHasData: false,
        analyticsTopics: [],
        currentView: null,
        currentInsights: null,
        analyticsViewCache: new Map(),
        filters: {
            ...FILTER_DEFAULTS
        },
        theme: 'light'
    };

    let elements = null;
    let progressValue = 0;
    let progressAnimationId = null;
    let analyticsRenderFrame = null;
    let lastViewKey = null;
    let analyticsWorker = null;
    let analyticsRequestId = 0;
    let pendingViewId = 0;

    function init() {
        elements = getElements();
        if (!elementsReady(elements)) {
            return;
        }
        elements.progressOverlay.hidden = true;
        elements.chartTooltip.hidden = true;
        initTheme();
        bindEvents();
        initAnalyticsWorker();
        initRoughDecorations();
        updateUploadUI();
        updateHubSummary();
        updateCleanOptions();
        updateAnalyticsVisibility();
        updateInsightsVisibility();
    }

    function getElements() {
        return {
            themeToggle: document.getElementById('themeToggle'),
            screens: {
                upload: document.getElementById('upload-screen'),
                hub: document.getElementById('hub-screen'),
                clean: document.getElementById('clean-screen'),
                analytics: document.getElementById('analytics-screen'),
                insights: document.getElementById('insights-screen')
            },
            multiDropZone: document.getElementById('multiDropZone'),
            multiFileInput: document.getElementById('multiFileInput'),
            sharesStatus: document.getElementById('sharesStatus'),
            commentsStatus: document.getElementById('commentsStatus'),
            uploadHint: document.getElementById('uploadHint'),
            continueBtn: document.getElementById('continueBtn'),
            fileStatusItems: {
                shares: document.querySelector('.file-status-item[data-file="shares"]'),
                comments: document.querySelector('.file-status-item[data-file="comments"]')
            },
            hubCards: document.querySelectorAll('.hub-card'),
            hubFileSummary: document.getElementById('hubFileSummary'),
            hubHint: document.getElementById('hubHint'),
            uploadDifferentBtn: document.getElementById('uploadDifferentBtn'),
            backButtons: document.querySelectorAll('.back-btn'),
            cleanFileTypeInputs: document.querySelectorAll('input[name="cleanFileType"]'),
            cleanerHint: document.getElementById('cleanerHint'),
            cleanPreviewSection: document.getElementById('cleanPreviewSection'),
            cleanPreviewTable: document.getElementById('cleanPreviewTable'),
            cleanFileInfo: document.getElementById('cleanFileInfo'),
            cleanPreviewNote: document.getElementById('cleanPreviewNote'),
            cleanDownloadSection: document.getElementById('cleanDownloadSection'),
            cleanDownloadBtn: document.getElementById('cleanDownloadBtn'),
            cleanResetBtn: document.getElementById('cleanResetBtn'),
            cleanErrorMessage: document.getElementById('cleanErrorMessage'),
            cleanErrorText: document.getElementById('cleanErrorText'),
            timeRangeButtons: document.querySelectorAll('#timeRangeButtons .filter-btn'),
            topicSelect: document.getElementById('topicSelect'),
            resetFiltersBtn: document.getElementById('resetFiltersBtn'),
            activeFilters: document.getElementById('activeFilters'),
            activeFiltersList: document.getElementById('activeFiltersList'),
            analyticsEmpty: document.getElementById('analyticsEmpty'),
            analyticsGrid: document.getElementById('analyticsGrid'),
            statsGrid: document.getElementById('statsGrid'),
            timelineChart: document.getElementById('timelineChart'),
            topicsChart: document.getElementById('topicsChart'),
            heatmapChart: document.getElementById('heatmapChart'),
            mixChart: document.getElementById('mixChart'),
            statPosts: document.getElementById('statPosts'),
            statComments: document.getElementById('statComments'),
            statTotal: document.getElementById('statTotal'),
            statPeak: document.getElementById('statPeak'),
            statStreak: document.getElementById('statStreak'),
            insightsGrid: document.getElementById('insightsGrid'),
            insightsEmpty: document.getElementById('insightsEmpty'),
            insightTip: document.getElementById('insightTip'),
            insightTipText: document.getElementById('insightTipText'),
            progressOverlay: document.getElementById('progressOverlay'),
            progressCanvas: document.getElementById('progressCanvas'),
            progressPercent: document.getElementById('progressPercent'),
            chartTooltip: document.getElementById('chartTooltip')
        };
    }

    function elementsReady(el) {
        return Boolean(el.themeToggle && el.multiDropZone && el.multiFileInput && el.continueBtn);
    }

    function initAnalyticsWorker() {
        if (typeof Worker === 'undefined') {
            analyticsWorker = null;
            return;
        }
        analyticsWorker = new Worker('js/analytics-worker.js');
        analyticsWorker.addEventListener('message', handleWorkerMessage);
        analyticsWorker.addEventListener('error', handleWorkerError);
    }

    function initTheme() {
        const savedTheme = localStorage.getItem('linkedin-analyzer-theme');
        const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        state.theme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
        applyTheme(state.theme);

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
            if (!localStorage.getItem('linkedin-analyzer-theme')) {
                state.theme = event.matches ? 'dark' : 'light';
                applyTheme(state.theme);
                redrawCharts();
            }
        });
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        state.theme = theme;
    }

    function toggleTheme() {
        const newTheme = state.theme === 'light' ? 'dark' : 'light';
        applyTheme(newTheme);
        localStorage.setItem('linkedin-analyzer-theme', newTheme);
        initRoughDecorations();
        redrawCharts();
    }

    function bindEvents() {
        elements.themeToggle.addEventListener('click', toggleTheme);

        elements.multiDropZone.addEventListener('click', () => elements.multiFileInput.click());
        elements.multiDropZone.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                elements.multiFileInput.click();
            }
        });
        elements.multiFileInput.addEventListener('change', handleFileInput);
        elements.multiDropZone.addEventListener('dragover', handleDragOver);
        elements.multiDropZone.addEventListener('dragleave', handleDragLeave);
        elements.multiDropZone.addEventListener('drop', handleDrop);
        window.addEventListener('dragover', (event) => event.preventDefault());
        window.addEventListener('drop', (event) => event.preventDefault());

        elements.continueBtn.addEventListener('click', () => navigateTo('hub'));

        elements.hubCards.forEach(card => {
            card.addEventListener('click', () => {
                const target = card.getAttribute('data-target');
                if (target) {
                    navigateTo(target);
                }
            });
        });

        elements.uploadDifferentBtn.addEventListener('click', handleUploadDifferent);

        elements.backButtons.forEach(button => {
            button.addEventListener('click', () => {
                const target = button.getAttribute('data-target');
                if (target) {
                    navigateTo(target);
                }
            });
        });

        elements.cleanFileTypeInputs.forEach(input => {
            input.addEventListener('change', renderCleanPreview);
        });
        elements.cleanDownloadBtn.addEventListener('click', handleCleanDownload);
        elements.cleanResetBtn.addEventListener('click', handleCleanReset);

        elements.timeRangeButtons.forEach(button => {
            button.addEventListener('click', () => handleTimeRangeChange(button));
        });
        elements.topicSelect.addEventListener('change', handleTopicChange);
        elements.resetFiltersBtn.addEventListener('click', resetFilters);
        elements.activeFiltersList.addEventListener('click', handleFilterChipClick);

        [elements.timelineChart, elements.topicsChart, elements.heatmapChart, elements.mixChart].forEach(canvas => {
            if (!canvas) return;
            canvas.addEventListener('mousemove', handleChartHover);
            canvas.addEventListener('mouseleave', hideTooltip);
            canvas.addEventListener('click', handleChartClick);
        });

        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                initRoughDecorations();
                redrawCharts();
                drawProgressBar(progressValue);
            }, 200);
        });
    }

    function handleWorkerMessage(event) {
        const message = event.data || {};
        if (message.type === 'init') {
            state.analyticsReady = true;
            state.analyticsHasData = Boolean(message.payload && message.payload.hasData);
            state.analyticsTopics = (message.payload && message.payload.topics) ? message.payload.topics : [];
            updateTopicSelect();
            updateAnalyticsVisibility();
            updateInsightsVisibility();
            if (state.currentScreen === 'analytics') {
                scheduleAnalyticsRender(true);
            }
            if (state.currentScreen === 'insights') {
                renderInsights();
            }
        }
        if (message.type === 'view') {
            if (message.requestId !== pendingViewId) {
                return;
            }
            state.currentView = message.payload ? message.payload.view : null;
            state.currentInsights = message.payload ? message.payload.insights : null;
            if (state.currentView && state.currentScreen === 'analytics') {
                renderAnalyticsView(state.currentView);
            }
            if (state.currentScreen === 'insights') {
                renderInsights();
            }
        }
        if (message.type === 'error') {
            showAnalyticsError(message.payload && message.payload.message ? message.payload.message : 'Analytics worker error.');
        }
    }

    function handleWorkerError(event) {
        console.error('Analytics worker error:', event);
        state.analyticsReady = false;
        state.analyticsHasData = false;
        showAnalyticsError('Analytics worker error.');
    }

    function handleDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        elements.multiDropZone.classList.add('drag-over');
    }

    function handleDragLeave(event) {
        event.preventDefault();
        event.stopPropagation();
        elements.multiDropZone.classList.remove('drag-over');
    }

    function handleDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        elements.multiDropZone.classList.remove('drag-over');
        const files = event.dataTransfer?.files;
        if (files && files.length > 0) {
            void processFiles(Array.from(files));
        }
    }

    function handleFileInput(event) {
        const files = Array.from(event.target.files || []);
        if (files.length) {
            void processFiles(files);
        }
        event.target.value = '';
    }

    async function processFiles(files) {
        const csvFiles = files.filter(file => file.name.toLowerCase().endsWith('.csv'));
        if (!csvFiles.length) {
            setUploadMessage('Please upload CSV files.', true);
            return;
        }
        showProgressOverlay();
        for (const file of csvFiles) {
            await processSingleFile(file);
        }
        finishProgressOverlay();
        state.filters.topic = 'all';
        state.filters.monthFocus = null;
        state.filters.day = null;
        state.filters.hour = null;
        state.filters.shareType = 'all';
        state.analyticsViewCache.clear();
        lastViewKey = null;
        state.currentView = null;
        state.currentInsights = null;
        updateUploadUI();
        updateHubSummary();
        updateCleanOptions();
        computeAnalytics();
        updateAnalyticsVisibility();
        updateInsightsVisibility();
    }

    async function processSingleFile(file) {
        try {
            const rawText = await readFileAsText(file);
            const processed = LinkedInCleaner.process(rawText, 'auto');
            if (!processed.success) {
                setUploadMessage(processed.error || 'Unable to process the file.', true);
                return;
            }
            const detectedType = processed.fileType;
            if (!detectedType || !['shares', 'comments'].includes(detectedType)) {
                setUploadMessage(`${file.name} does not look like Shares.csv or Comments.csv.`, true);
                return;
            }
            state.files[detectedType] = {
                name: file.name,
                cleaned: processed.cleanedData,
                rowCount: processed.rowCount,
                headers: processed.headers
            };
            setUploadMessage('File loaded successfully.', false);
        } catch (error) {
            setUploadMessage('Error reading file. Please try again.', true);
        }
    }

    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
            reader.onerror = () => reject(new Error('Error reading file.'));
            reader.readAsText(file);
        });
    }

    function setUploadMessage(message, isError) {
        elements.uploadHint.textContent = message;
        elements.uploadHint.classList.toggle('is-error', Boolean(isError));
    }

    function updateUploadUI() {
        const shares = state.files.shares;
        const comments = state.files.comments;

        if (shares) {
            elements.fileStatusItems.shares?.classList.add('is-ready');
            elements.sharesStatus.textContent = `${shares.rowCount} rows loaded`;
        } else {
            elements.fileStatusItems.shares?.classList.remove('is-ready');
            elements.sharesStatus.textContent = 'Not uploaded';
        }

        if (comments) {
            elements.fileStatusItems.comments?.classList.add('is-ready');
            elements.commentsStatus.textContent = `${comments.rowCount} rows loaded`;
        } else {
            elements.fileStatusItems.comments?.classList.remove('is-ready');
            elements.commentsStatus.textContent = 'Not uploaded';
        }

        const hasAny = Boolean(shares || comments);
        const hasBoth = Boolean(shares && comments);

        elements.continueBtn.disabled = !hasAny;

        if (!hasAny) {
            setUploadMessage('Upload at least one file to continue.', false);
        } else if (hasBoth) {
            setUploadMessage('Both files loaded. Continue to pick a feature.', false);
        } else if (shares) {
            setUploadMessage('Comments.csv is missing. Analytics will be partial.', false);
        } else {
            setUploadMessage('Shares.csv is missing. Analytics will be partial.', false);
        }
    }

    function updateHubSummary() {
        const shares = state.files.shares;
        const comments = state.files.comments;

        if (!shares && !comments) {
            elements.hubFileSummary.textContent = 'No files loaded.';
            elements.hubHint.textContent = '';
            return;
        }

        const parts = [];
        if (shares) {
            parts.push(`Shares.csv (${shares.rowCount})`);
        }
        if (comments) {
            parts.push(`Comments.csv (${comments.rowCount})`);
        }
        elements.hubFileSummary.textContent = `Files loaded: ${parts.join(' | ')}`;

        if (shares && comments) {
            elements.hubHint.textContent = 'All features are ready with full data.';
        } else {
            const missing = shares ? 'Comments.csv' : 'Shares.csv';
            elements.hubHint.textContent = `Add ${missing} for complete insights.`;
        }
    }

    function handleUploadDifferent() {
        clearAllData();
        navigateTo('upload');
    }

    function clearAllData() {
        state.files = { shares: null, comments: null };
        state.analytics = null;
        state.analyticsViewCache.clear();
        lastViewKey = null;
        state.filters = { ...FILTER_DEFAULTS };
        state.analyticsReady = false;
        state.analyticsHasData = false;
        state.analyticsTopics = [];
        state.currentView = null;
        state.currentInsights = null;
        if (analyticsWorker) {
            analyticsWorker.postMessage({ type: 'clear' });
        }
        updateUploadUI();
        updateHubSummary();
        updateCleanOptions();
        updateAnalyticsVisibility();
        updateInsightsVisibility();
        elements.topicSelect.value = 'all';
    }

    function navigateTo(screen) {
        if (state.currentScreen === screen) return;
        const current = elements.screens[state.currentScreen];
        const next = elements.screens[screen];
        if (!current || !next) return;

        next.classList.add('active', 'enter');
        current.classList.add('exit');

        setTimeout(() => {
            current.classList.remove('active', 'exit');
            next.classList.remove('enter');
        }, SCREEN_ANIMATION_MS);

        state.currentScreen = screen;

        if (screen === 'clean') {
            updateCleanOptions();
            renderCleanPreview();
        }
        if (screen === 'analytics') {
            scheduleAnalyticsRender(true);
        }
        if (screen === 'insights') {
            renderInsights();
        }
    }

    function updateCleanOptions() {
        const hasShares = Boolean(state.files.shares);
        const hasComments = Boolean(state.files.comments);

        elements.cleanFileTypeInputs.forEach(input => {
            if (input.value === 'shares') {
                input.disabled = !hasShares;
            }
            if (input.value === 'comments') {
                input.disabled = !hasComments;
            }
        });

        const selected = getSelectedCleanFileType();
        if (selected === 'shares' && !hasShares && hasComments) {
            const commentsRadio = document.querySelector('input[name="cleanFileType"][value="comments"]');
            if (commentsRadio) commentsRadio.checked = true;
        }
        if (selected === 'comments' && !hasComments && hasShares) {
            const sharesRadio = document.querySelector('input[name="cleanFileType"][value="shares"]');
            if (sharesRadio) sharesRadio.checked = true;
        }

        if (hasShares && hasComments) {
            elements.cleanerHint.textContent = 'Both files loaded. Choose which one to clean.';
        } else if (hasShares || hasComments) {
            elements.cleanerHint.textContent = 'Only one file is loaded. Upload the other for full features.';
        } else {
            elements.cleanerHint.textContent = 'Upload Shares.csv or Comments.csv to start cleaning.';
        }
    }

    function getSelectedCleanFileType() {
        const selected = document.querySelector('input[name="cleanFileType"]:checked');
        return selected ? selected.value : 'shares';
    }

    function renderCleanPreview() {
        const type = getSelectedCleanFileType();
        const fileData = state.files[type];
        if (!fileData) {
            hideCleanPreview();
            hideCleanDownload();
            showCleanError(`No ${type} file uploaded yet.`);
            return;
        }

        hideCleanError();
        showCleanPreview(fileData.cleaned, type, fileData.rowCount);
        showCleanDownload();
    }

    function showCleanPreview(cleanedData, fileType, rowCount) {
        const config = LinkedInCleaner.configs[fileType];
        if (!config) return;
        const headers = config.columns.map(column => column.name);
        elements.cleanFileInfo.textContent = `${fileType.charAt(0).toUpperCase() + fileType.slice(1)} - ${rowCount} rows`;

        const thead = elements.cleanPreviewTable.querySelector('thead');
        thead.innerHTML = `<tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr>`;

        const tbody = elements.cleanPreviewTable.querySelector('tbody');
        const previewRows = cleanedData.slice(0, PREVIEW_ROW_LIMIT);
        tbody.innerHTML = previewRows.map(row =>
            `<tr>${headers.map(header => {
                const value = row[header] || '';
                return `<td title="${escapeHtml(value)}">${escapeHtml(truncate(value, PREVIEW_CELL_LIMIT))}</td>`;
            }).join('')}</tr>`
        ).join('');

        elements.cleanPreviewNote.textContent = rowCount > PREVIEW_ROW_LIMIT
            ? `Showing first ${PREVIEW_ROW_LIMIT} of ${rowCount} rows`
            : `Showing all ${rowCount} rows`;

        elements.cleanPreviewSection.hidden = false;
    }

    function hideCleanPreview() {
        elements.cleanPreviewSection.hidden = true;
    }

    function showCleanDownload() {
        elements.cleanDownloadSection.hidden = false;
    }

    function hideCleanDownload() {
        elements.cleanDownloadSection.hidden = true;
    }

    function showCleanError(message) {
        elements.cleanErrorText.textContent = message;
        elements.cleanErrorMessage.hidden = false;
    }

    function hideCleanError() {
        elements.cleanErrorMessage.hidden = true;
    }

    function handleCleanDownload() {
        const type = getSelectedCleanFileType();
        const fileData = state.files[type];
        if (!fileData) {
            showCleanError(`No ${type} data available.`);
            return;
        }
        const result = ExcelGenerator.generateAndDownload(fileData.cleaned, type);
        if (!result.success) {
            showCleanError(`Error generating Excel: ${result.error}`);
        }
    }

    function handleCleanReset() {
        clearAllData();
        navigateTo('upload');
    }

    function computeAnalytics() {
        const shares = state.files.shares ? state.files.shares.cleaned : null;
        const comments = state.files.comments ? state.files.comments.cleaned : null;
        if (!shares && !comments) {
            state.analytics = null;
            state.analyticsReady = false;
            state.analyticsHasData = false;
            state.analyticsTopics = [];
            updateTopicSelect();
            return;
        }
        state.analyticsViewCache.clear();
        lastViewKey = null;

        if (analyticsWorker) {
            state.analytics = null;
            state.analyticsReady = false;
            state.analyticsHasData = false;
            state.analyticsTopics = [];
            state.currentView = null;
            state.currentInsights = null;
            updateTopicSelect();
            analyticsWorker.postMessage({
                type: 'init',
                payload: { shares, comments }
            });
            return;
        }

        state.analytics = AnalyticsEngine.compute(shares, comments);
        state.analyticsReady = true;
        state.analyticsHasData = Boolean(state.analytics && state.analytics.events && state.analytics.events.length);
        state.analyticsTopics = state.analytics.topics || [];
        updateTopicSelect();
    }

    function updateTopicSelect() {
        const current = state.filters.topic || 'all';
        elements.topicSelect.innerHTML = '<option value="all">All topics</option>';
        const topics = state.analyticsTopics || [];
        if (!topics.length) {
            elements.topicSelect.value = 'all';
            return;
        }
        topics.slice(0, 40).forEach(topic => {
            const option = document.createElement('option');
            option.value = topic.topic;
            option.textContent = `${topic.topic} (${topic.count})`;
            elements.topicSelect.appendChild(option);
        });
        const options = Array.from(elements.topicSelect.options).map(option => option.value);
        if (options.includes(current)) {
            elements.topicSelect.value = current;
        } else {
            elements.topicSelect.value = 'all';
            state.filters.topic = 'all';
        }
    }

    function updateAnalyticsVisibility() {
        const hasFiles = Boolean(state.files.shares || state.files.comments);
        const hasData = state.analyticsReady && state.analyticsHasData;

        if (!state.analyticsReady && hasFiles) {
            setAnalyticsEmpty('Preparing analytics', 'Crunching your data in the background.');
        } else if (!hasData) {
            setAnalyticsEmpty('No data available yet', 'Upload Shares.csv or Comments.csv to see analytics.');
        } else {
            elements.analyticsEmpty.hidden = true;
        }

        elements.analyticsGrid.hidden = !hasData;
        elements.statsGrid.hidden = !hasData;
        elements.activeFilters.hidden = !hasData;
        if (!hasData) {
            elements.activeFiltersList.innerHTML = '';
        }
        if (hasData && state.currentScreen === 'analytics') {
            scheduleAnalyticsRender(true);
        }
    }

    function updateInsightsVisibility() {
        const hasData = state.analyticsReady && state.analyticsHasData;
        elements.insightsEmpty.hidden = hasData;
        elements.insightsGrid.hidden = !hasData;
        elements.insightTip.hidden = !hasData;
        if (hasData && state.currentScreen === 'insights') {
            renderInsights();
        }
    }

    function handleTimeRangeChange(button) {
        const range = button.getAttribute('data-range');
        if (!range) return;
        state.filters.timeRange = range;
        resetFilterState({ preserveTimeRange: true });
        elements.timeRangeButtons.forEach(btn => btn.classList.toggle('active', btn === button));
        scheduleAnalyticsRender(true);
    }

    function handleTopicChange() {
        state.filters.topic = elements.topicSelect.value || 'all';
        scheduleAnalyticsRender(true);
    }

    function resetFilters() {
        state.filters = { ...FILTER_DEFAULTS };
        elements.timeRangeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-range') === '12m');
        });
        elements.topicSelect.value = 'all';
        scheduleAnalyticsRender(true);
    }

    function resetFilterState({ preserveTimeRange = false } = {}) {
        const timeRange = preserveTimeRange ? state.filters.timeRange : FILTER_DEFAULTS.timeRange;
        state.filters = {
            ...FILTER_DEFAULTS,
            timeRange
        };
        state.currentView = null;
        state.currentInsights = null;
        elements.topicSelect.value = 'all';
        elements.timeRangeButtons.forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-range') === timeRange);
        });
    }

    function handleFilterChipClick(event) {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        const filter = button.getAttribute('data-filter');
        if (filter === 'topic') {
            state.filters.topic = 'all';
            elements.topicSelect.value = 'all';
        }
        if (filter === 'month') {
            state.filters.monthFocus = null;
        }
        if (filter === 'day') {
            state.filters.day = null;
        }
        if (filter === 'hour') {
            state.filters.hour = null;
        }
        if (filter === 'shareType') {
            state.filters.shareType = 'all';
        }
        scheduleAnalyticsRender(true);
    }

    function renderAnalytics() {
        scheduleAnalyticsRender(true);
    }

    function requestAnalyticsView() {
        if (!state.analyticsReady && analyticsWorker) {
            showAnalyticsLoading(true);
            return;
        }
        if (analyticsWorker) {
            if (!state.analyticsHasData) {
                return;
            }
            const requestId = ++analyticsRequestId;
            pendingViewId = requestId;
            analyticsWorker.postMessage({
                type: 'view',
                requestId,
                filters: { ...state.filters }
            });
            showAnalyticsLoading(true);
            return;
        }
        if (!state.analytics || !state.analytics.events.length) {
            return;
        }
        const view = getCachedView();
        if (view) {
            renderAnalyticsView(view);
        }
    }

    function renderAnalyticsView(view) {
        showAnalyticsLoading(true);
        try {
            if (!view) {
                showAnalyticsError('No analytics data available.');
                return;
            }
            state.currentView = view;
            hideAnalyticsError();

            elements.statPosts.textContent = view.totals.posts;
            elements.statComments.textContent = view.totals.comments;
            elements.statTotal.textContent = view.totals.total;
            elements.statPeak.textContent = view.totals.total
                ? `${String(view.peakHour.hour).padStart(2, '0')}:00`
                : '-';
            elements.statStreak.textContent = view.totals.total
                ? `${view.streaks.current} days`
                : '0 days';

            renderActiveFilters();

            const animate = view.key !== lastViewKey && shouldAnimate(view);
            lastViewKey = view.key;

            if (animate) {
                SketchCharts.animateDraw((progress) => {
                    SketchCharts.drawTimeline(elements.timelineChart, view.timeline, progress);
                }, 520);
            } else {
                SketchCharts.drawTimeline(elements.timelineChart, view.timeline, 1);
            }

            if (animate) {
                SketchCharts.animateDraw((progress) => {
                    SketchCharts.drawTopics(elements.topicsChart, view.topics, progress);
                }, 520);
            } else {
                SketchCharts.drawTopics(elements.topicsChart, view.topics, 1);
            }

            SketchCharts.drawHeatmap(elements.heatmapChart, view.heatmap);

            if (animate) {
                SketchCharts.animateDraw((progress) => {
                    SketchCharts.drawDonut(elements.mixChart, view.contentMix, progress);
                }, 520);
            } else {
                SketchCharts.drawDonut(elements.mixChart, view.contentMix, 1);
            }
        } catch (error) {
            showAnalyticsError('Something went wrong while rendering analytics. Try resetting filters.');
            console.error('Analytics render error:', error);
        } finally {
            showAnalyticsLoading(false);
        }
    }

    function showAnalyticsLoading(isLoading) {
        if (!elements.analyticsGrid || !elements.statsGrid) return;
        elements.analyticsGrid.style.opacity = isLoading ? '0.5' : '1';
        elements.statsGrid.style.opacity = isLoading ? '0.5' : '1';
        elements.analyticsGrid.style.pointerEvents = isLoading ? 'none' : 'auto';
    }

    function showAnalyticsError(message) {
        setAnalyticsEmpty('Analytics error', message);
        elements.analyticsGrid.hidden = true;
        elements.statsGrid.hidden = true;
    }

    function hideAnalyticsError() {
        const hasData = state.analyticsReady && state.analyticsHasData;
        elements.analyticsEmpty.hidden = hasData;
        elements.analyticsGrid.hidden = !hasData;
        elements.statsGrid.hidden = !hasData;
    }

    function setAnalyticsEmpty(title, message) {
        const heading = elements.analyticsEmpty.querySelector('h2');
        const text = elements.analyticsEmpty.querySelector('p');
        if (heading) heading.textContent = title;
        if (text) text.textContent = message;
        elements.analyticsEmpty.hidden = false;
    }

    function getViewCacheKey(filters) {
        return [
            filters.timeRange,
            filters.topic,
            filters.monthFocus || 'none',
            filters.day !== null && filters.day !== undefined ? filters.day : 'none',
            filters.hour !== null && filters.hour !== undefined ? filters.hour : 'none',
            filters.shareType || 'all'
        ].join('|');
    }

    function shouldAnimate(view) {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return false;
        }
        return view.totals.total < 4000;
    }

    function getCachedView() {
        const key = getViewCacheKey(state.filters);
        if (state.analyticsViewCache.has(key)) {
            return state.analyticsViewCache.get(key);
        }
        const view = AnalyticsEngine.buildView(state.analytics, state.filters);
        if (!view) return null;
        const result = { ...view, key };
        state.analyticsViewCache.set(key, result);
        if (state.analyticsViewCache.size > 20) {
            state.analyticsViewCache.clear();
            state.analyticsViewCache.set(key, result);
        }
        return result;
    }

    function scheduleAnalyticsRender(force) {
        if (analyticsRenderFrame && !force) return;
        if (analyticsRenderFrame) {
            cancelAnimationFrame(analyticsRenderFrame);
        }
        analyticsRenderFrame = requestAnimationFrame(() => {
            analyticsRenderFrame = null;
            requestAnalyticsView();
        });
    }

    function renderActiveFilters() {
        const filters = [];
        if (state.filters.topic && state.filters.topic !== 'all') {
            filters.push({ key: 'topic', label: `Topic: ${state.filters.topic}` });
        }
        if (state.filters.monthFocus) {
            const [year, month] = state.filters.monthFocus.split('-').map(Number);
            const label = (year && month)
                ? `Month: ${AnalyticsEngine.MONTH_LABELS[month - 1]} ${year}`
                : `Month: ${state.filters.monthFocus}`;
            filters.push({ key: 'month', label });
        }
        if (state.filters.day !== null && state.filters.day !== undefined) {
            const label = AnalyticsEngine.DAY_LABELS[state.filters.day] || 'Unknown';
            filters.push({ key: 'day', label: `Day: ${label}` });
        }
        if (state.filters.hour !== null && state.filters.hour !== undefined) {
            filters.push({ key: 'hour', label: `Hour: ${String(state.filters.hour).padStart(2, '0')}:00` });
        }
        if (state.filters.shareType && state.filters.shareType !== 'all') {
            const map = { text: 'Text posts', links: 'Link posts', media: 'Media posts' };
            filters.push({ key: 'shareType', label: `Content: ${map[state.filters.shareType] || state.filters.shareType}` });
        }
        if (!filters.length) {
            elements.activeFilters.hidden = true;
            elements.activeFiltersList.innerHTML = '';
            return;
        }
        elements.activeFilters.hidden = false;
        elements.activeFiltersList.innerHTML = filters.map(filter =>
            `<span class="filter-chip">${filter.label}<button data-filter="${filter.key}" aria-label="Remove filter">x</button></span>`
        ).join('');
    }

    function renderInsights() {
        if (analyticsWorker) {
            if (!state.analyticsReady || !state.analyticsHasData) {
                return;
            }
            const expectedKey = getViewCacheKey(state.filters);
            if (!state.currentInsights || !state.currentView || state.currentView.key !== expectedKey) {
                scheduleAnalyticsRender(true);
                return;
            }
            renderInsightsView(state.currentInsights);
            return;
        }
        if (!state.analytics || !state.analytics.events.length) {
            return;
        }
        const view = getCachedView();
        if (!view) return;
        renderInsightsView(AnalyticsEngine.generateInsights(view));
    }

    function renderInsightsView(payload) {
        if (!payload) return;
        const insights = payload.insights || [];
        const tip = payload.tip || null;
        elements.insightsGrid.innerHTML = '';
        insights.slice(0, 6).forEach(insight => {
            const card = document.createElement('div');
            card.className = 'insight-card';
            card.dataset.accent = insight.accent;
            card.innerHTML = `
                <div class="insight-icon ${insight.accent}">${getInsightIcon(insight.icon)}</div>
                <div class="insight-body">
                    <h3>${escapeHtml(insight.title)}</h3>
                    <p>${escapeHtml(insight.body)}</p>
                </div>
            `;
            elements.insightsGrid.appendChild(card);
        });

        if (tip) {
            elements.insightTip.hidden = false;
            elements.insightTipText.textContent = tip;
        } else {
            elements.insightTip.hidden = true;
        }
    }

    function handleChartHover(event) {
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const item = SketchCharts.getItemAt(canvas, x, y);
        if (item && item.tooltip) {
            showTooltip(event.clientX, event.clientY, item.tooltip);
        } else {
            hideTooltip();
        }
        if (item && (item.type === 'month' || item.type === 'topic' || item.type === 'heatmap' || item.type === 'mix')) {
            canvas.style.cursor = 'pointer';
        } else {
            canvas.style.cursor = 'default';
        }
    }

    function handleChartClick(event) {
        const canvas = event.currentTarget;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const item = SketchCharts.getItemAt(canvas, x, y);
        if (!item) return;
        if (item.type === 'month') {
            state.filters.monthFocus = state.filters.monthFocus === item.key ? null : item.key;
            scheduleAnalyticsRender(true);
        }
        if (item.type === 'topic') {
            state.filters.topic = item.key;
            elements.topicSelect.value = item.key;
            scheduleAnalyticsRender(true);
        }
        if (item.type === 'heatmap') {
            const isSame = state.filters.day === item.day && state.filters.hour === item.hour;
            state.filters.day = isSame ? null : item.day;
            state.filters.hour = isSame ? null : item.hour;
            scheduleAnalyticsRender(true);
        }
        if (item.type === 'mix') {
            const map = { Text: 'text', Links: 'links', Media: 'media' };
            const value = map[item.label] || 'all';
            state.filters.shareType = state.filters.shareType === value ? 'all' : value;
            scheduleAnalyticsRender(true);
        }
    }

    function showTooltip(clientX, clientY, text) {
        elements.chartTooltip.textContent = text;
        elements.chartTooltip.hidden = false;
        const tooltipRect = elements.chartTooltip.getBoundingClientRect();
        let left = clientX + 12;
        let top = clientY + 12;
        if (left + tooltipRect.width > window.innerWidth) {
            left = clientX - tooltipRect.width - 12;
        }
        if (top + tooltipRect.height > window.innerHeight) {
            top = clientY - tooltipRect.height - 12;
        }
        elements.chartTooltip.style.left = `${left}px`;
        elements.chartTooltip.style.top = `${top}px`;
    }

    function hideTooltip() {
        elements.chartTooltip.hidden = true;
    }

    function redrawCharts() {
        if (state.currentScreen === 'analytics') {
            scheduleAnalyticsRender(true);
        }
        if (state.currentScreen === 'insights') {
            renderInsights();
        }
    }

    function getInsightIcon(name) {
        const icons = {
            rooster: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="16" fill="none" stroke="currentColor" stroke-width="2"/><path d="M24 20 Q28 12 32 18 Q36 12 40 20" fill="none" stroke="currentColor" stroke-width="2"/><path d="M40 32 L50 28" fill="none" stroke="currentColor" stroke-width="2"/><path d="M22 44 Q32 52 42 44" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            owl: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="18" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="26" cy="30" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="38" cy="30" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M30 40 L32 42 L34 40" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            rocket: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 6 C44 12 52 24 52 34 C52 46 42 54 32 58 C22 54 12 46 12 34 C12 24 20 12 32 6 Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="32" cy="30" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M26 58 L22 62 L30 60" fill="none" stroke="currentColor" stroke-width="2"/><path d="M38 58 L42 62 L34 60" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            sloth: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="18" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="26" cy="30" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="38" cy="30" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M28 40 Q32 44 36 40" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 24 Q32 18 44 24" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            monkey: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="16" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="30" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="46" cy="30" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="26" cy="30" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="38" cy="30" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M26 40 Q32 44 38 40" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            handshake: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 36 L24 24 L34 34" fill="none" stroke="currentColor" stroke-width="2"/><path d="M54 36 L40 24 L30 34" fill="none" stroke="currentColor" stroke-width="2"/><path d="M24 24 L32 18 L40 24" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            trophy: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M20 12 H44 V24 C44 32 38 38 32 38 C26 38 20 32 20 24 Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 12 H8 C8 24 14 30 20 30" fill="none" stroke="currentColor" stroke-width="2"/><path d="M48 12 H56 C56 24 50 30 44 30" fill="none" stroke="currentColor" stroke-width="2"/><path d="M28 38 V48 H36 V38" fill="none" stroke="currentColor" stroke-width="2"/><path d="M24 52 H40" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            calendar: `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="12" y="16" width="40" height="36" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 26 H52" fill="none" stroke="currentColor" stroke-width="2"/><path d="M22 12 V20 M42 12 V20" fill="none" stroke="currentColor" stroke-width="2"/><path d="M22 36 L28 42 L40 30" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
            flame: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 10 C36 18 26 22 30 30 C32 34 40 34 40 42 C40 50 34 54 32 54 C26 54 22 48 22 42 C22 34 28 30 26 24" fill="none" stroke="currentColor" stroke-width="2"/></svg>`
        };
        return icons[name] || icons.calendar;
    }

    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value;
        return div.innerHTML;
    }

    function truncate(value, maxLength) {
        if (!value) return '';
        if (value.length <= maxLength) return value;
        return value.slice(0, maxLength) + '...';
    }

    function showProgressOverlay() {
        elements.progressOverlay.hidden = false;
        progressValue = 0;
        drawProgressBar(progressValue);
        animateProgressTo(0.85, 900);
    }

    function finishProgressOverlay() {
        animateProgressTo(1, 300, () => {
            setTimeout(() => {
                elements.progressOverlay.hidden = true;
            }, 200);
        });
    }

    function animateProgressTo(target, duration, callback) {
        if (progressAnimationId) {
            cancelAnimationFrame(progressAnimationId);
        }
        const start = performance.now();
        const startValue = progressValue;

        function step(now) {
            const elapsed = now - start;
            const t = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - t, 3);
            progressValue = startValue + (target - startValue) * eased;
            drawProgressBar(progressValue);
            if (t < 1) {
                progressAnimationId = requestAnimationFrame(step);
            } else if (callback) {
                callback();
            }
        }

        progressAnimationId = requestAnimationFrame(step);
    }

    function drawProgressBar(value) {
        const canvas = elements.progressCanvas;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        canvas.width = rect.width * ratio;
        canvas.height = rect.height * ratio;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);

        const styles = getComputedStyle(document.documentElement);
        const border = styles.getPropertyValue('--border-color').trim();
        const fill = styles.getPropertyValue('--accent-purple').trim();

        const trackX = 8;
        const trackY = rect.height / 2 - 10;
        const trackWidth = rect.width - 16;
        const trackHeight = 20;

        if (typeof rough !== 'undefined') {
            const rc = rough.canvas(canvas);
            rc.rectangle(trackX, trackY, trackWidth, trackHeight, {
                stroke: border,
                strokeWidth: 1.5,
                roughness: 1.4
            });
            const fillWidth = Math.max(4, (trackWidth - 4) * value);
            ctx.fillStyle = fill;
            ctx.globalAlpha = 0.6;
            ctx.fillRect(trackX + 2, trackY + 2, fillWidth, trackHeight - 4);
            ctx.globalAlpha = 1;
            rc.rectangle(trackX + 2, trackY + 2, fillWidth, trackHeight - 4, {
                stroke: fill,
                strokeWidth: 1.2,
                roughness: 1.2
            });
        }

        elements.progressPercent.textContent = `${Math.round(value * 100)}%`;
    }

    function initRoughDecorations() {
        const canvas = document.getElementById('roughCanvas');
        if (!canvas || typeof rough === 'undefined') return;

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const rc = rough.canvas(canvas);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const isDark = state.theme === 'dark';
        const colors = {
            blue: isDark ? 'rgba(127, 179, 213, 0.15)' : 'rgba(91, 155, 213, 0.1)',
            yellow: isDark ? 'rgba(247, 220, 111, 0.1)' : 'rgba(244, 208, 63, 0.08)',
            purple: isDark ? 'rgba(187, 143, 206, 0.1)' : 'rgba(155, 89, 182, 0.08)'
        };

        rc.circle(canvas.width - 120, 180, 220, {
            fill: colors.blue,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });

        rc.circle(80, canvas.height - 160, 190, {
            fill: colors.purple,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });

        rc.circle(canvas.width - 240, canvas.height - 140, 120, {
            fill: colors.yellow,
            fillStyle: 'solid',
            stroke: 'transparent',
            roughness: 2
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
