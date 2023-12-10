#pragma once
#include <string_view>

template<typename T>
struct string_split
{
    class iterator
    {
    public:
        iterator() = default;
        iterator(std::basic_string_view<T> backed_view, std::basic_string_view<T> delim) : backed_view(backed_view), delim(delim) { cache_next_word(); }

        std::basic_string_view<T> operator*() { return cur_cache; }
        iterator &operator++()
        {
            cache_next_word();
            return *this;
        }
        iterator operator++(int)
        {
            auto t = *this;
            cache_next_word();
            return t;
        }

        std::strong_ordering operator<=>(const iterator &o) const = default;

    private:
        std::basic_string_view<T> backed_view{};
        std::basic_string_view<T> delim{};
        size_t cur_pos{};
        std::basic_string_view<T> cur_cache{};
        void cache_next_word()
        {
            if (backed_view.empty() || delim.empty() || cur_pos == std::string_view::npos)
            {
                *this = {};
                return;
            }
            // try getting the next word
            auto next_pos = backed_view.find(delim.data(), cur_pos);
            if (next_pos == std::basic_string_view<T>::npos){
                cur_cache = backed_view.substr(cur_pos);
                cur_pos = std::basic_string_view<T>::npos;
            }
            else{
                cur_cache = backed_view.substr(cur_pos, next_pos - cur_pos);
                cur_pos = next_pos + delim.length();
            }
        }
    };
    std::basic_string_view<T> backed_view{};
    std::basic_string_view<T> delim{};
    iterator begin() const { return {backed_view, delim}; }
    iterator end() const { return {}; }
};