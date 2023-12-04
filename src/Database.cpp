#include "Database.hpp"
#include <filesystem>
#include <fstream>
#include <sstream>
#include <numeric>

#include "util.hpp"
#include "type_serialization.hpp"
#include "string_split.hpp"
#include "AdminCredentials.hpp"

using src_loc = std::source_location;
using Types = std::vector<uint32_t>;
using OffsetSizes = std::vector<std::pair<uint64_t, uint64_t>>;

// Database utility functions -------------------------------------------------------------

template <typename T>
bool same_data_layout(const std::span<T> &a, const std::span<Database::ColumnType> &b)
{
    if (a.size() != b.size())
        return false;

    for (auto i : i_range(a.size()))
        if (a[i].index() != b[i].index())
            return false;

    return true;
}
template <typename T>
bool same_data_layout_without_id(const std::span<T> &a, const std::span<Database::ColumnType> &b, uint32_t id_column)
{
    if (a.size() + 1 != b.size())
        return false;

    for (auto i : i_range(a.size()))
    {
        const auto b_ind = i < id_column ? i : i + 1;
        if (a[i].index() != b[b_ind].index())
            return false;
    }

    return true;
}
// ----------------------------------------------------------------------------------------

Database::Table::Table(std::string_view storage_location, const std::optional<ColumnInfos> &column_infos) : storage_location(std::string(storage_location))
{
    auto file_parent_path = std::filesystem::path(storage_location).parent_path();
    if (!std::filesystem::exists(file_parent_path))
        std::filesystem::create_directory(file_parent_path);

    // loading from file --------------------------------------------------------
    std::ifstream data_file(this->storage_location, std::ios_base::binary);
    if (data_file)
    {
        GeneralHeader general_header{};
        data_file.read(reinterpret_cast<char *>(&general_header), sizeof(general_header));
        if (general_header.magic_num != DBTABLEMAGICNUM)
            throw std::runtime_error{log_msg("Magic number for header mismatch")};

        // parse into the correct special header
        if (general_header.type == columnar_header_id)
        {
            HeaderDataColumnar header{};
            data_file.read(reinterpret_cast<char *>(&header), sizeof(header));

            // getting the column infos
            this->column_infos.id_column = header.id_column;
            std::string column_names;
            column_names.resize(header.column_names_len);
            data_file.seekg(header.column_names_offset, data_file.beg).read(column_names.data(), header.column_names_len);
            std::stringstream column_names_stream(column_names);
            this->column_infos.column_names.resize(header.num_columns);
            for (uint32_t i : i_range(header.num_columns))
                column_names_stream >> this->column_infos.column_names[i];

            Types types(header.num_columns);
            data_file.seekg(header.column_types_offset, data_file.beg).read(reinterpret_cast<char *>(types.data()), header.num_columns * sizeof(types[0]));
            this->column_infos.column_types.resize(header.num_columns);
            for (auto i : i_range(header.num_columns))
                visit_column_type_idx([this, i](auto &&v)
                                      { this->column_infos.column_types[i] = std::string(column_type_name_v<std::decay_t<decltype(v)>>); },
                                      types[i]);

            OffsetSizes offset_sizes(header.num_columns);
            data_file.seekg(header.columns_offsets_lengths, data_file.beg).read(reinterpret_cast<char *>(offset_sizes.data()), header.num_columns * sizeof(offset_sizes[0]));

            if (column_infos && *column_infos != this->column_infos)
                throw std::runtime_error{log_msg("Column mismatch for stored table and requested table format")};

            // load data (can be loaded without seeking, as they are in the storage sequentially)
            loaded_data.resize(header.num_columns);
            for (auto i : i_range(header.num_columns))
            {
                visit_column_type_idx([&i, this, &data_file, &offset_sizes, &header](auto &&v)
                                      {
                                          using T = std::decay_t<decltype(v)>;
                                          this->loaded_data[i] = deserialize_type<T>(data_file, offset_sizes[i], header.num_rows);
                                      },
                                      types[i]);
            }
            return;
        }
        else
            throw std::runtime_error{log_msg("Unknown header type")};
    }

    // validating the column name strings (no spaces allowed)
    for (const auto &n : column_infos->column_names)
        if (n.find(' ') != std::string::npos)
            throw std::runtime_error{log_msg("The column names for a new table are not allowed to contain spaces.")};
    this->column_infos = *column_infos;
    this->loaded_data.resize(this->column_infos.column_names.size());
    for (auto i : i_range(_num_columns()))
    {
        visit_column_typename([&i, this](auto &&v)
                              {
                                  using T = std::decay_t<decltype(v)>;
                                  this->loaded_data[i] = std::vector<T>{};
                              },
                              column_infos->column_types[i]);
    }

    store_cache();
}

void Database::Table::store_cache() const
{
    std::unique_lock lock(mutex);
    // TODO put into an extra worker thread which does the export in the background

    std::ofstream file(storage_location, std::ios_base::binary);

    // gathering header additional infos
    std::stringstream names_stream;
    for (const auto &name : column_infos.column_names)
        names_stream << name << ' ';
    std::string names_string = names_stream.str();
    Types types(_num_columns());
    for (auto i : i_range(_num_columns()))
        types[i] = loaded_data[i].index();
    std::vector<uint64_t> column_sizes(_num_columns());
    for (auto i : i_range(_num_columns()))
        column_sizes[i] = std::visit([](auto &&v)
                                     { return serialized_size(v); },
                                     loaded_data[i]);

    // filling header infos
    GeneralHeader general_header{
        .magic_num = DBTABLEMAGICNUM,
        .type = columnar_header_id};
    HeaderDataColumnar header{
        .num_columns = _num_columns(),
        .num_rows = _num_rows(),
        .id_column = column_infos.id_column,
        .column_names_offset = static_cast<uint32_t>(sizeof(GeneralHeader) + sizeof(HeaderDataColumnar)),
        .column_names_len = static_cast<uint32_t>(names_string.length()),
        .column_types_offset = header.column_names_offset + header.column_names_len,
        .columns_offsets_lengths = header.column_types_offset + static_cast<uint32_t>(_num_columns() * sizeof(uint32_t))};
    size_t data_start = header.columns_offsets_lengths + 2 * _num_columns() * sizeof(uint64_t);

    OffsetSizes offset_lengths(_num_columns());
    for (auto i : i_range(_num_columns()))
    {
        if (i)
            offset_lengths[i].first = offset_lengths[i - 1].first + offset_lengths[i - 1].second;
        else
            offset_lengths[i].first = data_start;
        offset_lengths[i].second = column_sizes[i];
    }

    // writing to file
    file.write(reinterpret_cast<char *>(&general_header), sizeof(general_header));
    file.write(reinterpret_cast<char *>(&header), sizeof(header));
    file.write(names_string.data(), names_string.length() * sizeof(names_string[0]));
    serialize_type(file, types);
    serialize_type(file, offset_lengths);
    for (const auto &data : loaded_data)
        std::visit([&file](auto &&data)
                   { serialize_type(file, data); },
                   data);
}

template <typename T>
inline T get_free_id_impl(std::span<const T> v)
{
    auto m = std::ranges::max_element(v);
    if (m == v.end())
        return T{};
    else
        return (*m) + T{1};
}
template <>
inline Database::Date get_free_id_impl<Database::Date>(std::span<const Database::Date> v)
{
    auto m = std::ranges::max_element(v);
    if (m == v.end())
        return std::chrono::utc_clock::now();
    else
    {
        auto t = *m;
        return ++t;
    }
}
template <>
inline std::string get_free_id_impl<std::string>(std::span<const std::string> v)
{
    throw std::runtime_error{log_msg("There is no next free id for string. Only numeric types can be queried for next id")};
    return {};
}
template <>
inline std::vector<std::byte> get_free_id_impl<std::vector<std::byte>>(std::span<const std::vector<std::byte>> v)
{
    throw std::runtime_error{log_msg("There is no next free id for byte vectors. Only numeric types can be queried for next id")};
    return {};
}
Database::ElementType Database::Table::get_free_id() const
{
    return std::visit([this](auto &&v)
                      { return ElementType{get_free_id_impl(std::span(v))}; },
                      loaded_data[column_infos.id_column]);
}
Database::ColumnType Database::Table::get_free_ids(uint32_t num_ids) const
{
    return std::visit([num_ids, this](auto &&v)
                      {
                          std::decay_t<decltype(v)> ids(num_ids);
                          for (auto i : i_range(num_ids))
                              ids[i] = get_free_id_impl(std::span(v));
                          return ColumnType{std::move(ids)};
                      },
                      loaded_data[column_infos.id_column]);
}

void Database::Table::create_index() const
{
    {
        std::shared_lock index_lock(index_mutex);
        if (index.size())
            return;
    }
    std::unique_lock index_lock(index_mutex);
    _create_index();
}

void Database::Table::_create_index() const
{
    if (index.size())
        return;
    std::visit([this](auto &&data)
               {
                   for (auto i : i_range(data.size()))
                       index[ElementType{data[i]}] = i;
               },
               loaded_data[column_infos.id_column]);
}

void Database::Table::insert_row(const std::span<ElementType> &data)
{
    {
        std::shared_lock lock(mutex);
        if (!same_data_layout(data, loaded_data))
            throw std::runtime_error(log_msg("The data layout for inserting data into the table is different"));
    }

    std::unique_lock lock(mutex);
    for (auto i : i_range(data.size()))
    {
        std::visit([&data, &i](auto &&d)
                   {
                       using T = std::decay_t<decltype(d)>::value_type;
                       const auto &e = std::get<T>(data[i]);
                       d.emplace_back(e);
                   },
                   loaded_data[i]);
    }
    reset_index();
}

void Database::Table::insert_rows(const std::span<ColumnType> &data)
{
    {
        std::shared_lock lock(mutex);
        if (!same_data_layout(data, loaded_data))
            throw std::runtime_error(log_msg("The data layout for inserting data into the table is different"));
    }

    std::unique_lock lock(mutex);
    for (auto i : i_range(data.size()))
    {
        std::visit([&data, &i](auto &&d)
                   {
                       using T = std::decay_t<decltype(d)>;
                       const auto &data_v = std::get<T>(data[i]);
                       d.insert(d.end(), data_v.begin(), data_v.end());
                   },
                   loaded_data[i]);
    }
    reset_index();
}

Database::ElementType Database::Table::insert_row_without_id(const std::span<ElementType> &data)
{
    {
        std::shared_lock lock(mutex);
        if (!same_data_layout_without_id(data, loaded_data, column_infos.id_column))
            throw std::runtime_error{log_msg("the data layout for inserting data into the table is different")};
    }

    std::unique_lock lock(mutex);
    auto new_id = get_free_id();
    for (auto i : i_range(loaded_data.size()))
    {
        std::visit([&data, &i, &new_id, this](auto &&d)
                   {
                       using T = std::decay_t<decltype(d)>;
                       using ValueT = T::value_type;
                       const size_t data_i = i < this->column_infos.id_column ? i : i - 1;
                       d.emplace_back(i == this->column_infos.id_column ? std::get<ValueT>(new_id) : std::get<ValueT>(data[data_i]));
                   },
                   loaded_data[i]);
    }
    reset_index();
    return new_id;
}

Database::ColumnType Database::Table::insert_rows_without_id(const std::span<ColumnType> &data)
{
    {
        std::shared_lock lock(mutex);
        if (!same_data_layout_without_id(data, loaded_data, column_infos.id_column))
            throw std::runtime_error(log_msg("The data layout for inserting data into the table is different"));
    }

    std::unique_lock lock(mutex);
    const size_t data_size = std::visit([](auto &&v)
                                        { return v.size(); },
                                        data[0]);
    const auto ids = get_free_ids(data_size);
    for (auto i : i_range(data.size()))
    {
        std::visit([&data, i, &ids, data_size, this](auto &&d)
                   {
                       using T = std::decay_t<decltype(d)>;
                       if (i == this->column_infos.id_column)
                       {
                           using ValT = T::value_type;
                           for (auto i : i_range(data_size))
                               d.emplace_back(std::get<T>(ids)[i]);
                       }
                       else
                       {
                           const size_t data_i = i < this->column_infos.id_column ? i : i - 1;
                           const auto &data_v = std::get<T>(data[data_i]);
                           d.insert(d.end(), data_v.begin(), data_v.end());
                       }
                   },
                   loaded_data[i]);
    }
    reset_index();
    return ids;
}

void Database::Table::delete_row(const ElementType &id)
{
    {
        std::shared_lock lock(mutex);
        if (id.index() != loaded_data[column_infos.id_column].index())
            throw std::runtime_error{log_msg("The id value is not the same as in the table")};
    }

    std::unique_lock lock(mutex);
    size_t del_idx{};
    std::visit([this, &del_idx](auto &&id)
               {
                   using T = std::vector<std::decay_t<decltype(id)>>;
                   auto &v = std::get<T>(this->loaded_data[this->column_infos.id_column]);
                   auto p = std::ranges::find(v, id);
                   if (p == v.end())
                       throw std::runtime_error{log_msg("The id to delete is not in the table")};
                   del_idx = p - v.begin();
               },
               id);
    for (auto &data : loaded_data)
    {
        std::visit([&del_idx](auto &&v)
                   { v.erase(v.begin() + del_idx); },
                   data);
    }
    reset_index();
}

void Database::Table::delete_rows(const std::span<ElementType> &ids)
{
    if (ids.empty())
        return;
    {
        std::shared_lock lock(mutex);
        if (ids[0].index() != loaded_data[column_infos.id_column].index())
            throw std::runtime_error{log_msg("The id value is not the same as in the table")};
    }

    std::unique_lock lock(mutex);
    robin_hood::unordered_set<size_t> del_idx{};
    for (const auto &id : ids)
    {
        std::visit([this, &del_idx](auto &&id)
                   {
                       using T = std::vector<std::decay_t<decltype(id)>>;
                       auto &v = std::get<T>(this->loaded_data[this->column_infos.id_column]);
                       auto p = std::ranges::find(v, id);
                       del_idx.insert(p - v.begin());
                   },
                   id);
    }
    if (del_idx.empty())
        throw std::runtime_error{log_msg("The ids to delete were not in the table")};
    if (del_idx.size() != ids.size())
        CROW_LOG_WARNING << log_msg("Not all ids to delete were found in the table");

    for (auto &data : loaded_data)
    {
        std::visit([del_idx](auto &&v)
                   {
                       size_t cur_write{};
                       for (auto i : i_range(v.size()))
                       {
                           if (!del_idx.contains(i))
                           {
                               v[cur_write++] = v[i];
                           }
                       }
                       v.resize(cur_write);
                   },
                   data);
    }
    reset_index();
}

void Database::Table::update_row(const std::span<ElementType> row)
{
    {
        std::shared_lock lock(mutex);
        if (row.size() != _num_columns())
            throw std::runtime_error{log_msg("The amount of elements does not coincide with the table")};
        if (row[column_infos.id_column].index() != loaded_data[column_infos.id_column].index())
            throw std::runtime_error{log_msg("The id value is not the same as in the table")};
    }

    std::unique_lock lock(mutex);
    uint64_t i{npos};
    if (index.size())
    {
        std::shared_lock index_lock(index_mutex);
        i = index.at(row[column_infos.id_column]);
    }
    if (i == npos)
        i = std::visit([this, &row](auto &&v)
                       {
                           using T = std::decay_t<decltype(v)>::value_type;
                           return std::distance(v.begin(), std::ranges::find(v, std::get<T>(row[this->column_infos.id_column])));
                       },
                       loaded_data[column_infos.id_column]);
    if (i >= _num_rows())
        throw std::runtime_error{log_msg("The index for the row to update was not found")};

    for (auto j : i_range(_num_columns()))
    {
        std::visit([i, j, &row](auto &&v)
                   {
                       using T = std::decay_t<decltype(v)>::value_type;
                       v[i] = std::get<T>(row[j]);
                   },
                   loaded_data[j]);
    }
}

bool Database::Table::contains(const ElementType& id) const 
{
    {
        std::shared_lock lock(mutex);
        if (id.index() != loaded_data[column_infos.id_column].index())
            throw std::runtime_error{log_msg("The id value has nothte same type as the id column of the tabel")};
    }
    std::shared_lock lock(mutex);
    create_index();
    return index.contains(id);
}

Database::Database(std::string_view storage_location) : _storage_location(storage_location)
{
    // checking for the config json in the storage location, if not available create
    // the config json contains infos about the already created tables and maybe additional future information

    if (!std::filesystem::exists(_storage_location))
        std::filesystem::create_directories(_storage_location);

    std::string config_file = _storage_location + "/config.json";
    if (std::filesystem::exists(config_file))
    {
        // loading the json
        std::ifstream json_file(config_file);
        auto config_json = nlohmann::json::parse(json_file);
        if (config_json.contains("tables") && config_json["tables"].is_array())
        {
            for (const auto &table : config_json["tables"].get<std::vector<std::string>>())
                _tables[table] = std::make_unique<Table>(_storage_location + "/" + table);
        }
    }
}

void Database::store_table_caches() const
{
    std::unique_lock lock(_mutex);
    std::vector<std::string> tables(_tables.size());
    size_t i{};
    for (const auto &[n, t] : _tables)
        tables[i++] = n;
    nlohmann::json config_json{{"tables", std::move(tables)}};
    std::ofstream config_file(_storage_location + "/config.json");
    config_file << config_json.dump();
    for (const auto &[n, t] : _tables)
        t->store_cache();
}

void Database::create_table(std::string_view table_name, const Table::ColumnInfos &column_infos)
{
    std::unique_lock lock(_mutex);
    const std::string table_name_s(table_name);
    if (_tables.contains(table_name_s))
    {
        if (column_infos != _tables.at(table_name_s)->column_infos)
            throw std::runtime_error(log_msg("A table with the same name and different columns already exists"));
    }
    else
    {
        _tables[table_name_s] = std::make_unique<Table>(_storage_location + '/' + table_name_s, std::optional<Table::ColumnInfos>{column_infos});
    }
}

Database::ElementType Database::get_free_id(std::string_view table) const
{
    std::shared_lock lock(_mutex);
    const std::string table_s(table);
    if (!_tables.contains(table_s))
        throw std::runtime_error{log_msg("The table for which the next id should be acquired does not exits")};
    return _tables.at(table_s)->get_free_id();
}

const std::vector<Database::ColumnType> &Database::get_table_data(std::string_view table)
{
    std::shared_lock lock(_mutex);
    const std::string table_s(table);
    if (!_tables.contains(table_s))
        throw std::runtime_error(log_msg("The table from which the data should be returned does not exist"));
    return _tables.at(table_s)->loaded_data;
}

void Database::insert_rows(std::string_view table, const std::span<ColumnType> &data)
{
    std::shared_lock lock(_mutex);
    const std::string table_s(table);
    if (!_tables.contains(table_s))
        throw std::runtime_error{log_msg("The table into which data should be inserted does not exist")};
    _tables.at(table_s)->insert_rows(data);
}

void Database::insert_row(std::string_view table, const std::span<ElementType> &data)
{
    std::shared_lock lock(_mutex);
    const std::string table_s(table);
    if (!_tables.contains(table_s))
        throw std::runtime_error{log_msg("The table into which data should be inserted does not exist")};
    _tables.at(table_s)->insert_row(data);
}

Database::ElementType Database::insert_row_without_id(std::string_view table, const std::span<ElementType> &data)
{
    std::shared_lock lock(_mutex);
    const std::string table_s(table);
    if (!_tables.contains(table_s))
        throw std::runtime_error{log_msg("The table into which data should be inserted does not exist")};
    return _tables.at(table_s)->insert_row_without_id(data);
}

Database::ColumnType Database::insert_rows_without_id(std::string_view table, const std::span<ColumnType> &data)
{
    std::shared_lock lock(_mutex);
    const std::string table_s(table);
    if (!_tables.contains(table_s))
        throw std::runtime_error{log_msg("The table into which data should be inserted does not exist")};
    return _tables.at(table_s)->insert_rows_without_id(data);
}

void Database::delete_row(std::string_view table, const ElementType &id)
{
    std::shared_lock lock(_mutex);
    const std::string table_s(table);
    if (!_tables.contains(table_s))
        throw std::runtime_error{log_msg("The table from which ids should be deleted does not exist")};
    _tables.at(table_s)->delete_row(id);
}

void Database::delete_rows(std::string_view table, const std::span<ElementType> &ids)
{
    std::shared_lock lock(_mutex);
    const std::string table_s(table);
    if (!_tables.contains(table_s))
        throw std::runtime_error{log_msg("The table from which ids should be deleted does not exist")};
    _tables.at(table_s)->delete_rows(ids);
}

void Database::update_row(std::string_view table, const std::span<ElementType> row)
{
    std::shared_lock lock(_mutex);
    const std::string table_s(table);
    if (!_tables.contains(table_s))
        throw std::runtime_error{log_msg("The table from which ids should be deleted does not exist")};
    _tables.at(table_s)->update_row(row);
}

bool Database::contains(std::string_view table, const ElementType &id) const
{
    std::shared_lock lock(_mutex);
    const std::string table_s(table);
    if (!_tables.contains(table_s))
        throw std::runtime_error{log_msg("The table on which contains should be called does not exist")};
    return _tables.at(table_s)->contains(id);
}

// ------------------------------------------------------------------------------------------------------
// database queries
// ------------------------------------------------------------------------------------------------------
template <typename T>
std::vector<Database::ColumnType> Database::_query_database(const T &query) const
{
    static_assert(database_internal::always_false_v<T>, "Missing implementation for this query type");
    return {};
}
template <>
std::vector<Database::ColumnType> Database::_query_database<database_internal::EventQuery>(const database_internal::EventQuery &query) const
{
    if (!_tables.contains(query.event_table_name))
        throw std::runtime_error{log_msg("The table for the event query does not exist")};

    const auto &table = *_tables.at(query.event_table_name);
    const auto &visibilities_col = std::distance(table.column_infos.column_names.begin(), std::ranges::find(table.column_infos.column_names, "visibility"));
    const auto &visibilities = std::get<std::vector<std::string>>(table.loaded_data[visibilities_col]);

    if (query.query_person == admin_name)
        return table.loaded_data;

    // query run to build up the bitset
    Bitset active_indices;

    for (auto i : i_range(table._num_rows()))
    {
        for (auto user : string_split{json_array_to_comma_list(visibilities[i]), std::string_view(",")})
        {
            if (query.query_person == user || user == "Alle")
            {
                active_indices.set(i);
                break;
            }
        }
    }

    // creating the result array and gathering all elements from the table
    std::vector<Database::ColumnType> res(table._num_columns());
    for (auto i : i_range(table._num_columns()))
    {
        res[i] = std::visit([&active_indices](auto &&v)
                            {
                                using T = std::decay_t<decltype(v)>;
                                T res(active_indices.count());
                                size_t c{};
                                for (auto i : active_indices)
                                    res[c++] = v[i];
                                return ColumnType{res};
                            },
                            table.loaded_data[i]);
    }

    return res;
}
template <>
std::vector<Database::ColumnType> Database::_query_database<database_internal::IDQuery>(const database_internal::IDQuery &query) const
{
    if (!_tables.contains(query.table_name))
        throw std::runtime_error{log_msg("The table for the id query does not exist")};

    auto &table = *_tables.at(query.table_name);
    if (query.id.index() != table.loaded_data[table.column_infos.id_column].index())
        throw std::runtime_error{log_msg("The table for the id query has a different id type than given in the qeury")};

    std::shared_lock lock(table.mutex);
    if (table.index.empty())
        table.create_index();

    if (!table.index.contains(query.id))
        throw std::runtime_error{log_msg("The id searched for is not in the database")};

    auto row_idx = table.index.at(query.id);
    std::vector<ColumnType> res(table._num_columns());
    for (auto i : i_range(table._num_columns()))
    {
        res[i] = std::visit([row_idx](auto &&v)
                            {
                                using T = std::decay_t<decltype(v)>;
                                return ColumnType{T{v[row_idx]}};
                            },
                            table.loaded_data[i]);
    }
    return res;
}

std::vector<Database::ColumnType> Database::query_database(const QueryType &query) const
{
    std::shared_lock lock(_mutex);
    return std::visit([this](auto &&q)
                      { return this->_query_database(q); },
                      query);
}