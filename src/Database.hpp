#pragma once

#include <string_view>
#include <string>
#include <variant>
#include <vector>
#include <array>
#include <chrono>
#include <inttypes.h>
#include <memory>
#include <unordered_map>

#include "nlohmann/json.hpp"
#include "Bitset.hpp"
#include "robin_hood/robin_hood.h"

constexpr uint64_t DBTABLEMAGICNUM = 0x409ca93b33af;
constexpr uint32_t DBTABLEKINDSTRINGLEN = 4;

namespace database_internal
{
    using Date = std::chrono::system_clock::time_point;
    template <typename T>
    inline constexpr bool always_false_v = false;
    template <typename T>
    constexpr std::string_view column_type_name()
    {
        static_assert(always_false_v<T>, "Missing a column_type_name for a type.");
        return "error_type";
    };
    template <>
    constexpr std::string_view column_type_name<float>() { return "f32"; };
    template <>
    constexpr std::string_view column_type_name<double>() { return "f64"; };
    template <>
    constexpr std::string_view column_type_name<int32_t>() { return "i32"; };
    template <>
    constexpr std::string_view column_type_name<int64_t>() { return "i64"; };
    template <>
    constexpr std::string_view column_type_name<uint32_t>() { return "u32"; };
    template <>
    constexpr std::string_view column_type_name<uint64_t>() { return "u64"; };
    template <>
    constexpr std::string_view column_type_name<char>() { return "chr"; };
    template <>
    constexpr std::string_view column_type_name<std::string>() { return "str"; };
    template <>
    constexpr std::string_view column_type_name<Date>() { return "date"; };
    template <>
    constexpr std::string_view column_type_name<std::vector<std::byte>>() { return "bytes"; };
    template <typename Callable, typename... Ts>
    constexpr void variant_name_impl(Callable c, std::string_view type_name, std::variant<Ts...> **)
    {
        ((type_name != column_type_name<typename Ts::value_type>() || (c(typename Ts::value_type{}), false)) && ...);
    }
    template <typename Callable, typename... Ts>
    constexpr void variant_idx_impl(Callable c, size_t idx, std::variant<Ts...> **)
    {
        size_t i{};
        ((idx != i++ || (c((typename Ts::value_type){}), false)) && ...);
    }

}

// Class to store all kinds of tabular data, data is stored in column major format
class Database
{
public:
    using Date = std::chrono::system_clock::time_point;
    using ColumnType = std::variant<std::vector<float>,
                                    std::vector<double>,
                                    std::vector<int32_t>,
                                    std::vector<int64_t>,
                                    std::vector<uint32_t>,
                                    std::vector<uint64_t>,
                                    std::vector<char>,
                                    std::vector<std::string>,
                                    std::vector<Date>,
                                    std::vector<std::vector<std::byte>>>;
    using ElementType = std::decay_t<decltype(**variant_to_value_type(static_cast<ColumnType **>(nullptr)))>;
    template <typename T>
    static constexpr std::string_view column_type_name_v = database_internal::column_type_name<T>();
    template <typename Callable>
    static constexpr void visit_column_typename(Callable c, std::string_view type_name)
    {
        database_internal::variant_name_impl(c, type_name, static_cast<ColumnType **>(nullptr));
    }
    template <typename Callable>
    static constexpr void visit_column_type_idx(Callable c, size_t idx)
    {
        database_internal::variant_idx_impl(c, idx, static_cast<ColumnType **>(nullptr));
    }
    struct Table
    {
        // there might be more header datas coming, currently only columnar is available
        struct GeneralHeader
        {
            uint64_t magic_num;
            std::array<char, DBTABLEKINDSTRINGLEN> type;
        };
        static constexpr std::array<char, DBTABLEKINDSTRINGLEN> columnar_header_id{'c', 'o', 'l', '1'};
        struct HeaderDataColumnar
        {
            // The data layout is the following (number after colon is the byte offset)
            // GeneralHeader: 0,
            // HeaderDataColumnar: sizeof(GeneralHeader),
            // ColumnNames: column_names_offset
            // ColumnTypes: column_types_offset
            // ColumnOffsetsLengths: columns_offset_lengths_offset (for each column one offset + length exists here)
            // Columns
            uint32_t num_columns;
            uint64_t num_rows;
            uint32_t id_column;
            uint32_t column_names_offset;
            uint32_t column_names_len;
            uint32_t column_types_offset;
            uint32_t columns_offsets_lengths;
        };
        template <typename T>
        static constexpr size_t type_id = variant_index_v<std::vector<T>, ColumnType>;
        std::string storage_location{};
        std::vector<ColumnType> loaded_data{}; // this is only the data cache, might be missing part of the data in the file
        uint64_t loaded_data_offset{};
        struct ColumnInfos
        {
            std::vector<std::string> column_names{};
            std::vector<std::string> column_types{}; // this vector is only allowed to contain values from the
            uint32_t id_column{};

            bool operator==(const ColumnInfos &) const = default;
            uint32_t num_columns() const { return column_names.size(); }
        } column_infos{};

        // If column_infos is empty, the table layout is loaded from the stored data.
        // If no column_infos is given and the file does not exist on the computer an error will be thrown
        Table(std::string_view storage_location, const std::optional<ColumnInfos> &column_infos = {});
        ~Table() { store_cache(); }

        void store_cache() const;
        size_t num_rows() const
        {
            if (loaded_data.empty())
                return size_t{};
            return std::visit([](auto &&v)
                              { return v.size(); },
                              loaded_data[0]);
        }
        ElementType get_free_id() const;

        void insert_row(const nlohmann::json &element);
        void insert_row(const std::vector<ElementType> &data);
        // same as insert_row but requires the elements to be an array or a set of valid element objects
        void insert_rows(const nlohmann::json &elements);
        void insert_rows(const std::vector<ColumnType> &data);
        
        void delete_row(const ElementType& id);
        void delete_rows(const std::vector<ElementType>& ids);

        // filter_args must have the following structure: {column_name, check_operation}
        Bitset get_active_bitset(const nlohmann::json &filter_args);
        nlohmann::json get_elements(const Bitset &filter_args);
        nlohmann::json get_elements(const nlohmann::json &filter_args);
    };

    Database(std::string_view storage_location);
    ~Database() { store_table_caches(); }

    void store_table_caches() const;
    void create_table(std::string_view table_name, const Table::ColumnInfos &column_infos);
    ElementType get_free_id(std::string_view table_name) const;
    void insert_row(std::string_view table, const std::vector<ElementType> &row);
    void insert_rows(std::string_view table, const std::vector<ColumnType> &data);
    void delete_row(std::string_view table, const ElementType &id);
    void delete_rows(std::string_view table, const std::vector<ElementType> &ids);
    const std::vector<ColumnType> &get_table_data(std::string_view table);

private:
    std::string _storage_location;
    robin_hood::unordered_map<std::string, std::unique_ptr<Table>> _tables;
};
