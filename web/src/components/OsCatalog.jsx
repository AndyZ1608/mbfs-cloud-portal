import React, { useState } from 'react';
import { Disc3, Search } from 'lucide-react';
import { useI18n } from '../i18n/react.jsx';
import { catalogGroups, distroKey, distroLabel, imageMetadata } from '../osCatalog.js';

export default function OsCatalog({ images, selectedImageId, onSelect, disabled = false }) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [selectedDistro, setSelectedDistro] = useState(null);
  const other = t('instance.create.otherOs');
  const groups = catalogGroups(images, search, other);
  const selectedImage = images.find((image) => image.id === selectedImageId);
  const activeDistro = selectedDistro ?? (selectedImage ? distroKey(selectedImage) : null);
  const activeGroup = groups.find((group) => group.key === activeDistro);

  return <section className="os-catalog" aria-label={t('instance.create.operatingSystem')}>
    <h3>{t('instance.create.operatingSystem')}</h3>
    <label className="os-catalog-search">
      <Search size={16} aria-hidden="true" />
      <input type="search" value={search} disabled={disabled}
        placeholder={t('instance.create.searchOs')} aria-label={t('instance.create.searchOs')}
        onChange={(event) => setSearch(event.target.value)} />
    </label>
    <div className="os-catalog-heading">{t('instance.create.osDistribution')}</div>
    {groups.length ? <div className="os-distro-grid">
      {groups.map((group) => <button type="button" key={group.key}
        className={`os-distro-card${activeDistro === group.key ? ' selected' : ''}`}
        aria-pressed={activeDistro === group.key} disabled={disabled}
        onClick={() => { setSelectedDistro(group.key); onSelect(''); }}>
        <Disc3 size={19} aria-hidden="true" />
        <span><strong>{distroLabel(group.key, other)}</strong><small>{t('instance.create.imageCount', { count: group.images.length })}</small></span>
      </button>)}
    </div> : <p className="dim">{t(images.length ? 'instance.create.noSearchResults' : 'instance.create.noImages')}</p>}
    {activeGroup && <>
      <div className="os-catalog-heading">{t('instance.create.availableImages')}</div>
      <div className="os-image-list" role="radiogroup" aria-label={t('instance.create.availableImages')}>
        {activeGroup.images.map((image) => {
          const version = imageMetadata(image, 'os_version');
          const architecture = imageMetadata(image, 'architecture');
          const minRam = Number(image.min_ram);
          const minDisk = Number(image.min_disk);
          return <label className={`os-image-row${selectedImageId === image.id ? ' selected' : ''}`} key={image.id}>
            <input type="radio" name="create-image" value={image.id} checked={selectedImageId === image.id}
              disabled={disabled} onChange={() => onSelect(image.id)} />
            <span><strong>{image.name || image.id}</strong><small>
              {version && <span>{t('instance.create.imageVersion')}: {version}</span>}
              {architecture && <span>{t('instance.create.architecture')}: {architecture}</span>}
              {Number.isFinite(minRam) && minRam > 0 && <span>{t('instance.create.minimumRam')}: {minRam} MB</span>}
              {Number.isFinite(minDisk) && minDisk > 0 && <span>{t('instance.create.minimumDisk')}: {minDisk} GB</span>}
            </small></span>
          </label>;
        })}
      </div>
    </>}
    {selectedImage && <div className="os-selected-image">
      <span>{t('instance.create.selectedImage')}</span>
      <strong>{selectedImage.name || selectedImage.id}</strong>
      <small>{[distroLabel(distroKey(selectedImage), other), imageMetadata(selectedImage, 'os_version'), imageMetadata(selectedImage, 'architecture')].filter(Boolean).join(' · ')}</small>
    </div>}
  </section>;
}
