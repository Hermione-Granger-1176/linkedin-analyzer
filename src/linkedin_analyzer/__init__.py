"""LinkedIn data export analyzer - Clean and export LinkedIn CSV data to Excel."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

from linkedin_analyzer.cleaners.comments import CommentsCleanerConfig, clean_comments
from linkedin_analyzer.cleaners.connections import ConnectionsCleanerConfig, clean_connections
from linkedin_analyzer.cleaners.messages import MessagesCleanerConfig, clean_messages
from linkedin_analyzer.cleaners.shares import SharesCleanerConfig, clean_shares
from linkedin_analyzer.core.types import CleanerConfig, ColumnConfig

try:
    __version__ = version("linkedin-analyzer")
except PackageNotFoundError:
    __version__ = "0.0.0"

__all__ = [
    "CleanerConfig",
    "ColumnConfig",
    "CommentsCleanerConfig",
    "ConnectionsCleanerConfig",
    "MessagesCleanerConfig",
    "SharesCleanerConfig",
    "__version__",
    "clean_comments",
    "clean_connections",
    "clean_messages",
    "clean_shares",
]
