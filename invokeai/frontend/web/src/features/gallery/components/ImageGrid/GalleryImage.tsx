import { Box, Flex } from '@chakra-ui/react';
import { useStore } from '@nanostores/react';
import { $customStarUI } from 'app/store/nanostores/customStarUI';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import IAIDndImage from 'common/components/IAIDndImage';
import IAIFillSkeleton from 'common/components/IAIFillSkeleton';
import { imagesToDeleteSelected } from 'features/deleteImageModal/store/slice';
import {
  ImageDTOsDraggableData,
  ImageDraggableData,
  TypesafeDraggableData,
} from 'features/dnd/types';
import { VirtuosoGalleryContext } from 'features/gallery/components/ImageGrid/types';
import { useMultiselect } from 'features/gallery/hooks/useMultiselect';
import {
  MouseEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { FaTrash } from 'react-icons/fa';
import { MdStar, MdStarBorder } from 'react-icons/md';
import {
  useGetImageDTOQuery,
  useStarImagesMutation,
  useUnstarImagesMutation,
} from 'services/api/endpoints/images';
import IAIDndImageIcon from '../../../../common/components/IAIDndImageIcon';

interface HoverableImageProps {
  imageName: string;
  index: number;
  virtuosoContext: VirtuosoGalleryContext;
}

const GalleryImage = (props: HoverableImageProps) => {
  const dispatch = useAppDispatch();
  const { imageName, virtuosoContext } = props;
  const { currentData: imageDTO } = useGetImageDTOQuery(imageName);
  const shift = useAppSelector((state) => state.hotkeys.shift);
  const { t } = useTranslation();
  const { handleClick, isSelected, selection, selectionCount } =
    useMultiselect(imageDTO);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  const customStarUi = useStore($customStarUI);

  useEffect(() => {
    if (
      !isSelected ||
      selectionCount !== 1 ||
      !virtuosoContext.rootRef.current ||
      !virtuosoContext.virtuosoRef.current ||
      !virtuosoContext.rangeRef.current ||
      !imageContainerRef.current
    ) {
      return;
    }

    const root = virtuosoContext.rootRef.current;
    const virtuoso = virtuosoContext.virtuosoRef.current;
    const item = imageContainerRef.current;
    const range = virtuosoContext.rangeRef.current;
    const itemRect = item.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const itemIsVisible =
      itemRect.top >= rootRect.top &&
      itemRect.bottom <= rootRect.bottom &&
      itemRect.left >= rootRect.left &&
      itemRect.right <= rootRect.right;

    if (!itemIsVisible) {
      virtuoso.scrollToIndex({
        index: props.index,
        behavior: 'smooth',
        align:
          props.index >
          (range.endIndex - range.startIndex) / 2 + range.startIndex
            ? 'end'
            : 'start',
      });
    }
  }, [
    isSelected,
    props.index,
    selectionCount,
    virtuosoContext.rangeRef,
    virtuosoContext.rootRef,
    virtuosoContext.virtuosoRef,
  ]);

  const handleDelete = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (!imageDTO) {
        return;
      }
      dispatch(imagesToDeleteSelected([imageDTO]));
    },
    [dispatch, imageDTO]
  );

  const draggableData = useMemo<TypesafeDraggableData | undefined>(() => {
    if (selectionCount > 1) {
      const data: ImageDTOsDraggableData = {
        id: 'gallery-image',
        payloadType: 'IMAGE_DTOS',
        payload: { imageDTOs: selection },
      };
      return data;
    }

    if (imageDTO) {
      const data: ImageDraggableData = {
        id: 'gallery-image',
        payloadType: 'IMAGE_DTO',
        payload: { imageDTO },
      };
      return data;
    }
  }, [imageDTO, selection, selectionCount]);

  const [starImages] = useStarImagesMutation();
  const [unstarImages] = useUnstarImagesMutation();

  const toggleStarredState = useCallback(() => {
    if (imageDTO) {
      if (imageDTO.starred) {
        unstarImages({ imageDTOs: [imageDTO] });
      }
      if (!imageDTO.starred) {
        starImages({ imageDTOs: [imageDTO] });
      }
    }
  }, [starImages, unstarImages, imageDTO]);

  const [isHovered, setIsHovered] = useState(false);

  const handleMouseOver = useCallback(() => {
    setIsHovered(true);
  }, []);

  const handleMouseOut = useCallback(() => {
    setIsHovered(false);
  }, []);

  const starIcon = useMemo(() => {
    if (imageDTO?.starred) {
      return customStarUi ? customStarUi.on.icon : <MdStar size="20" />;
    }
    if (!imageDTO?.starred && isHovered) {
      return customStarUi ? customStarUi.off.icon : <MdStarBorder size="20" />;
    }
  }, [imageDTO?.starred, isHovered, customStarUi]);

  const starTooltip = useMemo(() => {
    if (imageDTO?.starred) {
      return customStarUi ? customStarUi.off.text : 'Unstar';
    }
    if (!imageDTO?.starred) {
      return customStarUi ? customStarUi.on.text : 'Star';
    }
    return '';
  }, [imageDTO?.starred, customStarUi]);

  if (!imageDTO) {
    return <IAIFillSkeleton />;
  }

  return (
    <Box
      sx={{ w: 'full', h: 'full', touchAction: 'none' }}
      data-testid={`image-${imageDTO.image_name}`}
    >
      <Flex
        ref={imageContainerRef}
        userSelect="none"
        sx={{
          position: 'relative',
          justifyContent: 'center',
          alignItems: 'center',
          aspectRatio: '1/1',
        }}
      >
        <IAIDndImage
          onClick={handleClick}
          imageDTO={imageDTO}
          draggableData={draggableData}
          isSelected={isSelected}
          minSize={0}
          imageSx={{ w: 'full', h: 'full' }}
          isDropDisabled={true}
          isUploadDisabled={true}
          thumbnail={true}
          withHoverOverlay
          onMouseOver={handleMouseOver}
          onMouseOut={handleMouseOut}
        >
          <>
            <IAIDndImageIcon
              onClick={toggleStarredState}
              icon={starIcon}
              tooltip={starTooltip}
            />

            {isHovered && shift && (
              <IAIDndImageIcon
                onClick={handleDelete}
                icon={<FaTrash />}
                tooltip={t('gallery.deleteImage')}
                styleOverrides={{
                  bottom: 2,
                  top: 'auto',
                }}
              />
            )}
          </>
        </IAIDndImage>
      </Flex>
    </Box>
  );
};

export default memo(GalleryImage);
