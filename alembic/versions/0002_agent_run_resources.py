"""add run resources table

Revision ID: 0002_agent_run_resources
Revises: 0001_initial_runtime_tables
Create Date: 2026-04-27 00:00:00
"""

import sqlalchemy as sa

from alembic import op

revision = "0002_agent_run_resources"
down_revision = "0001_initial_runtime_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_run_resources",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "run_id",
            sa.String(length=36),
            sa.ForeignKey("agent_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("uri", sa.Text(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
    )
    op.create_index(
        "ix_agent_run_resources_run_position",
        "agent_run_resources",
        ["run_id", "position"],
        unique=True,
    )

def downgrade() -> None:
    op.drop_index("ix_agent_run_resources_run_position", table_name="agent_run_resources")
    op.drop_table("agent_run_resources")
