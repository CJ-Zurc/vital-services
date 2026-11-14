import pytest

from app.assets.build import _asset_output_path


def test_asset_output_protects_source_and_existing_unrelated_files(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    for output in (tmp_path, source, source / "nested"):
        with pytest.raises(ValueError, match="protected directory"):
            _asset_output_path(source, output)
    output = tmp_path / "assets"
    assert _asset_output_path(source, output) == output.resolve()
    output.mkdir()
    (output / "unrelated.txt").touch()
    with pytest.raises(ValueError, match="model manifest"):
        _asset_output_path(source, output)
    (output / "model_manifest.json").touch()
    assert _asset_output_path(source, output) == output.resolve()


def test_asset_output_rejects_symlink_and_linked_parent(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    link = tmp_path / "link"
    try:
        link.symlink_to(source, target_is_directory=True)
    except OSError:
        pytest.skip("Directory symlinks unavailable")
    for output in (link, link / "assets"):
        with pytest.raises(ValueError, match="filesystem link"):
            _asset_output_path(source, output)
