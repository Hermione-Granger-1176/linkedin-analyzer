/* Tutorial steps by route */

export const TutorialSteps = Object.freeze({
    home: [
        {
            id: 'home-welcome',
            route: 'home',
            title: 'Welcome to LinkedIn Analyzer',
            body: 'Start here to upload your LinkedIn CSV files, then move across pages to clean data and explore insights.',
            target: '#screen-home .hero-header',
            fallbackTarget: '#screen-home .screen-inner',
            placement: 'bottom',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'home-upload-zone',
            route: 'home',
            title: 'Upload your files',
            body: 'Drop your CSV files here or click to choose them from your computer. You can upload one file at a time or all together.',
            target: '#multiDropZone',
            fallbackTarget: '#multiFileInput',
            placement: 'right',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'home-file-status',
            route: 'home',
            title: 'Track upload progress',
            body: 'This panel shows which files are ready. Once at least one file is loaded, the analytics button becomes available.',
            target: '#fileStatusList',
            fallbackTarget: '.upload-status-card',
            placement: 'left',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'home-next-actions',
            route: 'home',
            title: 'Jump to any page',
            body: 'Use these cards to move quickly between cleaning, analytics, connections, messages, and personalized insights.',
            target: '#screen-home .hub-grid',
            fallbackTarget: '#screen-home .top-nav',
            placement: 'top',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'home-theme-toggle',
            route: 'home',
            title: 'Choose your preferred theme',
            body: 'Switch between light and dark mode at any time to make the app more comfortable for your eyes.',
            target: '#themeToggle',
            fallbackTarget: '#screen-home .hero-header',
            placement: 'bottom',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        }
    ],
    clean: [
        {
            id: 'clean-overview',
            route: 'clean',
            title: 'Clean your exported files',
            body: 'This page prepares your CSV data so it is easier to use in spreadsheets and reports.',
            target: '#screen-clean .screen-header',
            fallbackTarget: '#screen-clean .screen-inner',
            placement: 'bottom',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'clean-file-type',
            route: 'clean',
            title: 'Pick a file type',
            body: 'Choose the file you want to clean first. The options unlock automatically based on the uploads from Home.',
            target: '#screen-clean .file-type-options',
            fallbackTarget: '#cleanEmpty',
            placement: 'right',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'clean-preview',
            route: 'clean',
            title: 'Preview before download',
            body: 'Check a sample of cleaned rows to confirm the formatting looks right before exporting.',
            target: '#cleanPreviewSection',
            fallbackTarget: '#cleanPanel, #cleanEmpty',
            placement: 'top',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'clean-download',
            route: 'clean',
            title: 'Download cleaned Excel files',
            body: 'When ready, export your cleaned data as an Excel file and continue with analytics or sharing.',
            target: '#cleanDownloadBtn',
            fallbackTarget: '#cleanEmpty .action-buttons, #cleanEmpty',
            placement: 'top',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        }
    ],
    analytics: [
        {
            id: 'analytics-overview',
            route: 'analytics',
            title: 'Explore activity trends',
            body: 'Analytics combines your posts and comments so you can quickly spot patterns in your LinkedIn activity.',
            target: '#screen-analytics .screen-header',
            fallbackTarget: '#screen-analytics .screen-inner',
            placement: 'bottom',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'analytics-filters',
            route: 'analytics',
            title: 'Filter by time range',
            body: 'Use these controls to focus on recent months or your full history. Reset returns to the default view.',
            target: '#analyticsTimeRangeButtons',
            fallbackTarget: '#analyticsResetFiltersBtn',
            placement: 'bottom',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'analytics-charts',
            route: 'analytics',
            title: 'Interact with charts',
            body: 'Click chart points, words, or heatmap cells to refine the dashboard and reveal focused insights.',
            target: '#analyticsGrid',
            fallbackTarget: '#analyticsEmpty',
            placement: 'top',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'analytics-stats',
            route: 'analytics',
            title: 'Read your key metrics',
            body: 'These cards summarize totals, peak hour, and streak so you can understand your progress at a glance.',
            target: '#statsGrid',
            fallbackTarget: '#analyticsEmpty',
            placement: 'top',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        }
    ],
    connections: [
        {
            id: 'connections-overview',
            route: 'connections',
            title: 'Understand your network',
            body: 'This page shows how your connections have grown and which companies or roles appear most in your network.',
            target: '#screen-connections .screen-header',
            fallbackTarget: '#screen-connections .screen-inner',
            placement: 'bottom',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'connections-filters',
            route: 'connections',
            title: 'Focus the date range',
            body: 'Switch the time range to compare recent networking activity with your longer-term growth.',
            target: '#connectionsTimeRangeButtons',
            fallbackTarget: '#connectionsResetFiltersBtn',
            placement: 'bottom',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'connections-metrics',
            route: 'connections',
            title: 'Check connection highlights',
            body: 'Review totals, top company, and network age to get a quick health check of your professional network.',
            target: '#connectionsStatsGrid',
            fallbackTarget: '#connectionsEmpty',
            placement: 'top',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'connections-charts',
            route: 'connections',
            title: 'Dive into network charts',
            body: 'Use these visualizations to inspect growth trends and the companies or positions that dominate your network.',
            target: '#connectionsGrid',
            fallbackTarget: '#connectionsEmpty',
            placement: 'top',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        }
    ],
    messages: [
        {
            id: 'messages-overview',
            route: 'messages',
            title: 'Review conversation patterns',
            body: 'Messages highlights who you engage with most and where follow-up opportunities may exist.',
            target: '#screen-messages .screen-header',
            fallbackTarget: '#screen-messages .screen-inner',
            placement: 'bottom',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'messages-filters',
            route: 'messages',
            title: 'Adjust the time window',
            body: 'Use the time range controls to focus on current conversations or your full message history.',
            target: '#messagesTimeRangeButtons',
            fallbackTarget: '#messagesResetFiltersBtn',
            placement: 'bottom',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'messages-panels',
            route: 'messages',
            title: 'Compare conversation lists',
            body: 'Top Contacts, Silent Connections, and Fading Conversations help you decide where to reconnect next.',
            target: '#messagesLayout .message-panels',
            fallbackTarget: '#messagesEmpty',
            placement: 'top',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'messages-export',
            route: 'messages',
            title: 'Export full contact lists',
            body: 'Use the Full List buttons to download complete records for follow-up planning outside the app.',
            target: '#topContactsExportBtn',
            fallbackTarget: '#messagesEmpty',
            placement: 'left',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        }
    ],
    insights: [
        {
            id: 'insights-overview',
            route: 'insights',
            title: 'Get personalized takeaways',
            body: 'Insights turns your recent activity into short, practical recommendations you can apply right away.',
            target: '#screen-insights .screen-header',
            fallbackTarget: '#screen-insights .screen-inner',
            placement: 'bottom',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'insights-filters',
            route: 'insights',
            title: 'Choose the period to analyze',
            body: 'Change the time range to refresh recommendations for short-term momentum or long-term patterns.',
            target: '#insightsTimeRangeButtons',
            fallbackTarget: '#insightsResetFiltersBtn',
            placement: 'bottom',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'insights-cards',
            route: 'insights',
            title: 'Read your insight cards',
            body: 'Each card explains one key finding from your data in plain language so you can act on it quickly.',
            target: '#insightsGrid',
            fallbackTarget: '#insightsEmpty',
            placement: 'top',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        },
        {
            id: 'insights-tip',
            route: 'insights',
            title: 'Use the pro tip',
            body: 'When available, this tip gives you one focused action to improve consistency and engagement.',
            target: '#insightTip',
            fallbackTarget: '#insightsGrid, #insightsEmpty',
            placement: 'top',
            allowSkip: true,
            allowBack: true,
            allowNext: true
        }
    ]
});

export const TutorialMiniTips = Object.freeze({
    home: [
        {
            id: 'home-upload-tip',
            route: 'home',
            target: '#uploadHint',
            fallbackTarget: '#multiDropZone',
            placement: 'top',
            title: 'Tip',
            body: 'You can upload just one file now and add the rest later.'
        }
    ],
    clean: [
        {
            id: 'clean-preview-tip',
            route: 'clean',
            target: '#cleanPreviewNote',
            fallbackTarget: '#cleanerHint',
            placement: 'top',
            title: 'Tip',
            body: 'Preview first to avoid exporting the wrong file type.'
        }
    ],
    analytics: [
        {
            id: 'analytics-click-tip',
            route: 'analytics',
            target: '#timelineCard .chart-note',
            fallbackTarget: '#analyticsEmpty',
            placement: 'top',
            title: 'Tip',
            body: 'Clicking a chart detail updates the rest of the dashboard.'
        }
    ],
    connections: [
        {
            id: 'connections-range-tip',
            route: 'connections',
            target: '#growthCard .chart-header',
            fallbackTarget: '#connectionsEmpty',
            placement: 'top',
            title: 'Tip',
            body: 'Try 3 months first to see your recent networking momentum.'
        }
    ],
    messages: [
        {
            id: 'messages-followup-tip',
            route: 'messages',
            target: '#messagesTip',
            fallbackTarget: '#messagesLayout, #messagesEmpty',
            placement: 'top',
            title: 'Tip',
            body: 'Silent and fading lists are ideal for weekly follow-up goals.'
        }
    ],
    insights: [
        {
            id: 'insights-action-tip',
            route: 'insights',
            target: '#insightTip',
            fallbackTarget: '#insightsGrid, #insightsEmpty',
            placement: 'top',
            title: 'Tip',
            body: 'Pick one insight each week and track whether engagement improves.'
        }
    ]
});
