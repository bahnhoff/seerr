import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import defineMessages from '@app/utils/defineMessages';
import type { SeasonWithEpisodes } from '@server/models/Tv';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RequestModal.SeasonEpisodes', {
  somethingwentwrong: 'Something went wrong while retrieving season data.',
  noepisodes: 'Episode list unavailable.',
});

interface SeasonEpisodesProps {
  tmdbId: number;
  seasonNumber: number;
  selected: number[];
  onToggle: (episodeNumber: number) => void;
}

const SeasonEpisodes = ({
  tmdbId,
  seasonNumber,
  selected,
  onToggle,
}: SeasonEpisodesProps) => {
  const intl = useIntl();
  const { data, error } = useSWR<SeasonWithEpisodes>(
    `/api/v1/tv/${tmdbId}/season/${seasonNumber}`
  );

  if (!data && !error) {
    return (
      <div className="flex items-center justify-center p-4">
        <SmallLoadingSpinner />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-4 text-sm text-gray-400">
        {intl.formatMessage(messages.somethingwentwrong)}
      </div>
    );
  }

  const episodes = data.episodes.filter(
    (episode) => episode.episodeNumber !== 0
  );

  if (episodes.length === 0) {
    return (
      <div className="p-4 text-sm text-gray-400">
        {intl.formatMessage(messages.noepisodes)}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4">
      {episodes.map((episode) => (
        <label
          key={`episode-${episode.id}`}
          className="flex items-center gap-2 text-sm font-medium text-gray-100"
        >
          <input
            type="checkbox"
            checked={selected.includes(episode.episodeNumber)}
            onChange={() => onToggle(episode.episodeNumber)}
          />
          <span>
            {episode.episodeNumber}. {episode.name}
          </span>
        </label>
      ))}
    </div>
  );
};

export default SeasonEpisodes;
