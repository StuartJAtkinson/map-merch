from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from app.core.database import get_db
from app.models.db_models import DesignProject, User
from app.api.auth import get_current_user
from app.services.woocommerce import WooCommerceClient, WooCommerceError, build_product_payload

router = APIRouter(prefix="/api/projects", tags=["projects"])


class SaveProjectRequest(BaseModel):
    name: str
    merch_type: str
    bbox_west: float
    bbox_south: float
    bbox_east: float
    bbox_north: float
    coaster_shape: str | None = None
    palette_overrides: dict | None = None
    thumbnail_data_url: str | None = None


@router.get("")
async def list_projects(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(DesignProject)
        .where(DesignProject.user_id == user.id)
        .order_by(DesignProject.created_at.desc())
    )
    return [
        {
            "id": p.id,
            "name": p.name,
            "merch_type": p.merch_type,
            "bbox": {"west": p.bbox_west, "south": p.bbox_south, "east": p.bbox_east, "north": p.bbox_north},
            "coaster_shape": p.coaster_shape,
            "palette_overrides": p.palette_overrides,
            "thumbnail_data_url": p.thumbnail_data_url,
            "created_at": p.created_at.isoformat(),
        }
        for p in result.scalars().all()
    ]


@router.post("", status_code=201)
async def save_project(
    req: SaveProjectRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = DesignProject(
        user_id=user.id,
        name=req.name,
        merch_type=req.merch_type,
        bbox_west=req.bbox_west,
        bbox_south=req.bbox_south,
        bbox_east=req.bbox_east,
        bbox_north=req.bbox_north,
        coaster_shape=req.coaster_shape,
        palette_overrides=req.palette_overrides,
        thumbnail_data_url=req.thumbnail_data_url,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return {"id": project.id, "name": project.name, "created_at": project.created_at.isoformat()}


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(DesignProject).where(DesignProject.id == project_id, DesignProject.user_id == user.id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    await db.delete(project)
    await db.commit()


@router.post("/{project_id}/product", status_code=201)
async def create_product(
    project_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a draft WooCommerce product from a saved design."""
    result = await db.execute(
        select(DesignProject).where(DesignProject.id == project_id, DesignProject.user_id == user.id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        client = WooCommerceClient.from_settings()
    except WooCommerceError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    try:
        async with client:
            product = await client.post("products", build_product_payload(project))
    except WooCommerceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"product_id": product["id"], "sku": product.get("sku"),
            "status": product.get("status"), "permalink": product.get("permalink")}
