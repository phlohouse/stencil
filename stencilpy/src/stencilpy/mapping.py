"""Render schema ranges over workbook examples as PNGs and a review page."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import warnings
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime
from html import escape
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.cell.cell import MergedCell
from openpyxl.utils import get_column_letter
from PIL import Image, ImageDraw, ImageFont

from ._map_page import render_page
from .addressing import parse_cell, parse_range
from .errors import StencilError
from .schema import StencilSchema
from .versioning import resolve_version

COLORS = {"table": "#2563eb", "list": "#0f766e", "cell": "#b45309"}


@dataclass(frozen=True)
class MapSource:
    schema: str | Path
    workbook: str | Path
    key: str | None = None


def _font(size: int, bold: bool = False):
    names = (
        ("DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf")
        if bold
        else ("DejaVuSans.ttf", "arial.ttf", "Arial.ttf")
    )
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def cell_text(cell):
    value = cell.value
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, datetime):
        return value.strftime(
            "%d/%m/%Y %H:%M" if value.time().isoformat() != "00:00:00" else "%d/%m/%Y"
        )
    if isinstance(value, date):
        return value.strftime("%d/%m/%Y")
    if isinstance(value, float):
        return format(value, ".12g")
    return str(value)


def fill_color(cell):
    if cell.fill.patternType == "solid" and cell.fill.fgColor.type == "rgb":
        rgb = cell.fill.fgColor.rgb[-6:]
        if rgb != "000000":
            return "#" + rgb
    return "#ffffff"


def draw_cell_text(image, box, cell, regular, bold):
    value = cell_text(cell)
    if not value:
        return False
    left, top, right, bottom = map(int, box)
    width, height = max(1, right - left - 8), max(1, bottom - top - 4)
    layer = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(layer)
    font = bold if cell.font.bold else regular
    lines = []
    for paragraph in value.splitlines():
        line = ""
        for word in paragraph.split(" "):
            candidate = (line + " " + word).strip()
            if line and draw.textlength(candidate, font=font) > width:
                lines.append(line)
                line = word
            else:
                line = candidate
        lines.append(line)
    if not cell.alignment.wrap_text:
        lines = [value.replace("\n", " ")]
    color = "#172033"
    if cell.font.color is not None and cell.font.color.type == "rgb":
        color = "#" + cell.font.color.rgb[-6:]
    for index, line in enumerate(lines):
        y = index * 14
        if y >= height:
            break
        text_width = draw.textlength(line, font=font)
        alignment = cell.alignment.horizontal
        x = (
            max(0, (width - text_width) / 2)
            if alignment == "center"
            else max(0, width - text_width)
            if alignment == "right"
            else 0
        )
        draw.text((x, y), line, font=font, fill=color)
    image.paste(layer, (left + 4, top + 3), layer)
    return True


def render_maps(sources: Iterable[MapSource], output: str | Path) -> Path:
    """Write a standalone HTML review and sibling PNG/manifest assets.

    Only mapped worksheets are included. Formula cells use cached values.
    No extraction is run and the source workbooks and schemas are never saved.
    """
    output = Path(output)
    if output.suffix.lower() != ".html":
        raise ValueError("Report output must be an .html file")
    sources = list(sources)
    if not sources:
        raise ValueError("Provide at least one schema/workbook pair")
    OUT = output.parent / (output.stem + "_assets")
    OUT.mkdir(parents=True, exist_ok=True)
    FONT, BOLD, TITLE = _font(11), _font(11, bold=True), _font(21)
    seen = set()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        panels = []
        manifest = []
        for item in sources:
            schema_path, source = Path(item.schema), Path(item.workbook)
            schema = StencilSchema.from_file(schema_path)
            key = item.key or schema.name + "--" + source.stem
            if key in seen:
                raise StencilError(f"Duplicate report source key: {key}")
            seen.add(key)
            book = load_workbook(source, data_only=True)
            try:
                version = resolve_version(schema, source, wb=book).version_key
                fields = schema.versions[version].fields
                groups = {sheet.title: [] for sheet in book.worksheets}
                for name, field in fields.items():
                    if field.cell:
                        address = parse_cell(field.cell)
                        sheet_name = address.sheet or book.worksheets[0].title
                        area = (address.col, address.row, address.col, address.row)
                        # The schema reads the anchor; the visual covers the complete merged cell.
                        for merge in book[sheet_name].merged_cells.ranges:
                            if (address.col, address.row) == (
                                merge.min_col,
                                merge.min_row,
                            ):
                                area = (
                                    merge.min_col,
                                    merge.min_row,
                                    merge.max_col,
                                    merge.max_row,
                                )
                                break
                        kind = "cell"
                    elif field.range:
                        address = parse_range(field.range)
                        sheet_name = address.sheet or book.worksheets[0].title
                        end_row = address.end_row or max(
                            address.start_row,
                            max(
                                (
                                    cell.row
                                    for cell in book[sheet_name]._cells.values()
                                    if cell.value is not None
                                ),
                                default=address.start_row,
                            ),
                        )
                        area = (
                            address.start_col,
                            address.start_row,
                            address.end_col,
                            end_row,
                        )
                        kind = "table" if field.is_table else "list"
                    else:
                        continue
                    groups[sheet_name].append(
                        {
                            "name": name,
                            "ref": field.cell or field.range,
                            "kind": kind,
                            "area": area,
                            "orientation": field.table_orientation,
                            "columns": (field.columns or {})
                            if field.is_table
                            else None,
                        }
                    )
                for sheet_name, regions in groups.items():
                    if not regions:
                        continue
                    sheet = book[sheet_name]
                    # Styled-only dimensions can extend to XFD; use populated cells for context.
                    populated = [
                        cell for cell in sheet._cells.values() if cell.value is not None
                    ]
                    source_rows = max((cell.row for cell in populated), default=1)
                    source_cols = max((cell.column for cell in populated), default=1)
                    raw_preview = sheet_name.lower() == "raw_data"
                    rows = max(
                        max(region["area"][3] for region in regions) + 2,
                        min(source_rows, 40) if raw_preview else source_rows,
                    )
                    cols = max(
                        max(region["area"][2] for region in regions) + 1,
                        min(source_cols, 20) if raw_preview else source_cols,
                    )
                    x = [46.0]
                    for col in range(1, cols + 1):
                        dimension = sheet.column_dimensions.get(get_column_letter(col))
                        source_width = (
                            dimension.width if dimension and dimension.width else 12
                        )
                        x.append(x[-1] + max(44, min(210, source_width * 7)))
                    measure = ImageDraw.Draw(Image.new("RGB", (1, 1)))
                    labels = {}
                    for region in regions:
                        first_col, first_row, _, _ = region["area"]
                        left = x[first_col - 1]
                        width = measure.textlength(region["name"], font=BOLD) + 12
                        lanes = labels.setdefault(first_row, [])
                        lane = next(
                            (
                                i
                                for i, items in enumerate(lanes)
                                if all(
                                    left + width + 6 < start or left > end + 6
                                    for start, end, _ in items
                                )
                            ),
                            len(lanes),
                        )
                        if lane == len(lanes):
                            lanes.append([])
                        lanes[lane].append((left, left + width, region))
                    column_labels = {}
                    mapping_heights = {}
                    for region in regions:
                        if region["kind"] != "table" or not region["columns"]:
                            continue
                        first_col, first_row, last_col, last_row = region["area"]
                        vertical = region["orientation"] == "vertical"
                        groups_for_table = []
                        if vertical:
                            axes = {str(row) for row in range(first_row, last_row + 1)}
                            if not set(region["columns"]) <= axes:
                                raise StencilError(
                                    f"Rows outside range for {region['name']}"
                                )
                            for row in range(first_row, last_row + 1):
                                if str(row) in region["columns"]:
                                    groups_for_table.append(
                                        (
                                            row,
                                            first_col,
                                            first_col,
                                            region["columns"][str(row)],
                                        )
                                    )
                                elif any(
                                    sheet.cell(row, col).value is not None
                                    for col in range(first_col + 1, last_col + 1)
                                ):
                                    raise StencilError(
                                        f"Unmapped populated row {row} in {region['name']}"
                                    )
                        else:
                            axes = {
                                get_column_letter(col)
                                for col in range(first_col, last_col + 1)
                            }
                            if not set(region["columns"]) <= axes:
                                raise StencilError(
                                    f"Columns outside range for {region['name']}"
                                )
                            for col in range(first_col, last_col + 1):
                                axis = get_column_letter(col)
                                if axis not in region["columns"]:
                                    if not groups_for_table or any(
                                        sheet.cell(row, col).value is not None
                                        for row in range(first_row, last_row + 1)
                                    ):
                                        raise StencilError(
                                            f"Unmapped populated or leading column {axis} in {region['name']}"
                                        )
                                    row, start, _, key_name = groups_for_table[-1]
                                    groups_for_table[-1] = (row, start, col, key_name)
                                else:
                                    groups_for_table.append(
                                        (first_row, col, col, region["columns"][axis])
                                    )
                        labels_for_table = []
                        for mapping_row, col, end_col, key_name in groups_for_table:
                            axis = (
                                str(mapping_row) if vertical else get_column_letter(col)
                            )
                            if end_col != col:
                                axis += ":" + get_column_letter(end_col)
                            label = f"{axis}: {key_name}"
                            available = x[end_col] - x[col - 1] - 8
                            lines, line = [], ""
                            for character in label:
                                if (
                                    line
                                    and measure.textlength(line + character, font=FONT)
                                    > available
                                ):
                                    split = max(line.rfind("_"), line.rfind(" ")) + 1
                                    if split:
                                        lines.append(line[:split])
                                        line = line[split:]
                                    else:
                                        lines.append(line)
                                        line = ""
                                line += character
                            if line:
                                lines.append(line)
                            assert "".join(lines) == label
                            assert all(
                                measure.textlength(line, font=FONT) <= available
                                for line in lines
                            )
                            labels_for_table.append(
                                (mapping_row, col, end_col, lines, key_name)
                            )
                            mapping_heights[mapping_row] = max(
                                mapping_heights.get(mapping_row, 0),
                                len(lines) * 14 + 10,
                            )
                        column_labels[region["name"]] = labels_for_table
                    tops, bottoms, tag_tops, mapping_tops = {}, {}, {}, {}
                    cursor = 112.0
                    for row in range(1, rows + 1):
                        tag_tops[row] = cursor
                        cursor += len(labels.get(row, [])) * 21 + (
                            5 if row in labels else 0
                        )
                        mapping_tops[row] = cursor
                        cursor += mapping_heights.get(row, 0)
                        tops[row] = cursor
                        cursor += max(
                            24, min(72, (sheet.row_dimensions[row].height or 18) * 1.3)
                        )
                        bottoms[row] = cursor
                    width = int(
                        max(
                            x[-1] + 14,
                            max(
                                end
                                for lanes in labels.values()
                                for lane in lanes
                                for _, end, _ in lane
                            )
                            + 12,
                            820,
                        )
                    )
                    height = int(cursor + 24)
                    image = Image.new("RGB", (width, height), "white")
                    draw = ImageDraw.Draw(image, "RGBA")
                    draw.text((12, 10), sheet_name, font=TITLE, fill="#0f172a")
                    draw.text(
                        (12, 43),
                        f"{schema.name} · {version} · {len(regions)} fields",
                        font=FONT,
                        fill="#475569",
                    )
                    note = (
                        "Example workbook contents · keys label the highlighted ranges"
                    )
                    if raw_preview and (source_rows > rows or source_cols > cols):
                        note += " · raw-data preview around mapped cells"
                    draw.text((12, 65), note, font=FONT, fill="#64748b")
                    draw.rectangle((0, 89, x[-1], 111), fill="#f1f5f9")
                    for col in range(1, cols + 1):
                        draw.text(
                            (x[col - 1] + 5, 92),
                            get_column_letter(col),
                            font=FONT,
                            fill="#64748b",
                        )
                    for row in range(1, rows + 1):
                        draw.rectangle((0, tops[row], 45, bottoms[row]), fill="#f8fafc")
                        draw.text(
                            (5, tops[row] + 5), str(row), font=FONT, fill="#64748b"
                        )
                        for col in range(1, cols + 1):
                            cell = sheet.cell(row, col)
                            box = (x[col - 1], tops[row], x[col], bottoms[row])
                            draw.rectangle(
                                box, fill=fill_color(cell), outline="#e2e8f0"
                            )
                            for side, coords in (
                                (cell.border.top, (box[0], box[1], box[2], box[1])),
                                (cell.border.bottom, (box[0], box[3], box[2], box[3])),
                                (cell.border.left, (box[0], box[1], box[0], box[3])),
                                (cell.border.right, (box[2], box[1], box[2], box[3])),
                            ):
                                if side and side.style:
                                    draw.line(coords, fill="#94a3b8", width=1)
                    merges = {}
                    for merge in sheet.merged_cells.ranges:
                        if merge.min_col <= cols and merge.min_row <= rows:
                            last_col, last_row = (
                                min(cols, merge.max_col),
                                min(rows, merge.max_row),
                            )
                            box = (
                                x[merge.min_col - 1],
                                tops[merge.min_row],
                                x[last_col],
                                bottoms[last_row],
                            )
                            merges[(merge.min_row, merge.min_col)] = box
                            draw.rectangle(
                                box,
                                fill=fill_color(
                                    sheet.cell(merge.min_row, merge.min_col)
                                ),
                                outline="#cbd5e1",
                            )
                    for region in regions:
                        c1, r1, c2, r2 = region["area"]
                        color = COLORS[region["kind"]]
                        rgb = tuple(int(color[i : i + 2], 16) for i in (1, 3, 5))
                        draw.rectangle(
                            (x[c1 - 1], tops[r1], x[c2], bottoms[r2]),
                            fill=(*rgb, 16),
                            outline=color,
                            width=2,
                        )
                    values_drawn = 0
                    for row in range(1, rows + 1):
                        for col in range(1, cols + 1):
                            cell = sheet.cell(row, col)
                            if isinstance(cell, MergedCell):
                                continue
                            box = merges.get(
                                (row, col),
                                (x[col - 1], tops[row], x[col], bottoms[row]),
                            )
                            values_drawn += draw_cell_text(image, box, cell, FONT, BOLD)
                    mapped_columns = 0
                    for region in regions:
                        if region["kind"] != "table" or not region["columns"]:
                            continue
                        for mapping_row, col, end_col, lines, _ in column_labels[
                            region["name"]
                        ]:
                            top = mapping_tops[mapping_row]
                            bottom = top + mapping_heights[mapping_row]
                            left, right = x[col - 1], x[end_col]
                            draw.rectangle(
                                (left, top, right, bottom),
                                fill="#eff6ff",
                                outline="#93c5fd",
                            )
                            for index, line in enumerate(lines):
                                draw.text(
                                    (left + 4, top + 5 + index * 14),
                                    line,
                                    font=FONT,
                                    fill="#1d4ed8",
                                )
                            mapped_columns += 1
                    assert mapped_columns == sum(
                        len(labels) for labels in column_labels.values()
                    )
                    review_buttons = []
                    review_fields = []
                    for row, lanes in labels.items():
                        for lane_index, lane in enumerate(lanes):
                            top = tag_tops[row] + lane_index * 21
                            for left, right, region in lane:
                                color = COLORS[region["kind"]]
                                draw.line(
                                    (
                                        left + 4,
                                        top + 18,
                                        left + 4,
                                        mapping_tops[row]
                                        if region["kind"] == "table"
                                        else tops[row],
                                    ),
                                    fill=color,
                                    width=1,
                                )
                                draw.rectangle(
                                    (left, top, right, top + 18),
                                    fill="white",
                                    outline=color,
                                    width=1,
                                )
                                draw.text(
                                    (left + 6, top + 2),
                                    region["name"],
                                    font=BOLD,
                                    fill=color,
                                )
                                review_id = json.dumps(
                                    [key, version, region["name"]],
                                    separators=(",", ":"),
                                )
                                item = {
                                    "id": review_id,
                                    "schema": schema_path.as_posix(),
                                    "version": version,
                                    "sheet": sheet_name,
                                    "key": region["name"],
                                    "current": region["ref"],
                                    "kind": region["kind"],
                                }
                                review_fields.append(item)
                                review_buttons.append(
                                    f'<button type="button" class="range-review" data-field="{escape(json.dumps(item), quote=True)}" '
                                    f'style="left:{left / width * 100:.8f}%;top:{top / height * 100:.8f}%;width:{(right - left) / width * 100:.8f}%;height:{19 / height * 100:.8f}%" '
                                    f'aria-label="Review {escape(region["name"], quote=True)} in {escape(key, quote=True)} {escape(sheet_name, quote=True)}" '
                                    f'title="Review {escape(region["name"], quote=True)}: {escape(region["ref"], quote=True)}"></button>'
                                )
                    slug = (
                        re.sub(
                            r"[^a-z0-9]+",
                            "_",
                            key.lower() + "__" + version + "__" + sheet_name.lower(),
                        ).strip("_")
                        + "_"
                        + hashlib.sha256(
                            (key + version + sheet_name).encode()
                        ).hexdigest()[:8]
                    )
                    image.save(OUT / (slug + ".png"))
                    encoded = base64.b64encode(
                        (OUT / (slug + ".png")).read_bytes()
                    ).decode("ascii")
                    panels.append(
                        f'<article><h2>{escape(schema.name)} · {escape(sheet_name)}</h2><p>{escape(version)} · {escape(source.name)}</p><div class="sheet-image" style="width:{width}px"><img src="data:image/png;base64,{encoded}" width="{width}" height="{height}" alt="{escape(sheet_name, quote=True)} example with highlighted and labelled schema ranges">{"".join(review_buttons)}</div></article>'
                    )
                    manifest.append(
                        {
                            "schema": key,
                            "version": version,
                            "sheet": sheet_name,
                            "fields": len(regions),
                            "png": slug + ".png",
                            "values_drawn": values_drawn,
                            "raw_preview": raw_preview,
                            "review_fields": review_fields,
                            "merged_highlights": {
                                region["name"]: {
                                    "source": region["ref"],
                                    "display": f"{get_column_letter(region['area'][0])}{region['area'][1]}:{get_column_letter(region['area'][2])}{region['area'][3]}",
                                }
                                for region in regions
                                if region["kind"] == "cell"
                                and (
                                    region["area"][0] != region["area"][2]
                                    or region["area"][1] != region["area"][3]
                                )
                            },
                            "mapped_columns": mapped_columns,
                            "physical_table_columns": {
                                region["name"]: region["columns"]
                                for region in regions
                                if region["kind"] == "table"
                            },
                            "table_orientations": {
                                region["name"]: region["orientation"]
                                for region in regions
                                if region["kind"] == "table"
                            },
                            "table_columns": {
                                region["name"]: {
                                    (
                                        str(row)
                                        if region["orientation"] == "vertical"
                                        else get_column_letter(col)
                                        + (
                                            (":" + get_column_letter(end_col))
                                            if end_col != col
                                            else ""
                                        )
                                    ): key_name
                                    for row, col, end_col, _, key_name in column_labels[
                                        region["name"]
                                    ]
                                }
                                for region in regions
                                if region["name"] in column_labels
                            },
                        }
                    )
            finally:
                book.close()
    if not manifest:
        raise StencilError("No mapped worksheets to render")
    storage_key = (
        "stencil-map-review-"
        + hashlib.sha256(str(output.resolve()).encode()).hexdigest()[:16]
    )
    page = render_page(panels, storage_key)
    output.write_text(page, encoding="utf-8")
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    return output
